#lang racket/base

;; 原语过程:把宿主 Racket 过程包成 Piper primitive,装进全局环境。
;; 只放最小的不可约原语;list/map/filter 等高阶或可派生的工具
;; 用 Piper 自身写在 lib/prelude.piper 里(以此检验求值器)。

(require "env.rkt" "eval.rkt" "llm.rkt")
(provide make-global-env (struct-out checkpoint))

;; 状态检查点:全局环境某一刻的快照(纯数据)。
;; 与控制无关——控制跳转由 call/cc 负责;capture/restore 只管"状态"。
;; 这是事务性自修改(M6)与 amb 回溯(M3)的状态回滚基石。
(struct checkpoint (vars) #:transparent)

(define (make-global-env)
  (define g (make-env))
  (define (def! name proc) (env-define! g name (primitive name proc)))

  ;; 算术 / 数值
  (def! '+ +) (def! '- -) (def! '* *) (def! '/ /)
  (def! 'modulo modulo) (def! 'remainder remainder) (def! 'quotient quotient)
  (def! 'abs abs) (def! 'min min) (def! 'max max)
  (def! 'add1 add1) (def! 'sub1 sub1)
  (def! 'zero? zero?) (def! 'number? number?)

  ;; 比较
  (def! '= =) (def! '< <) (def! '> >) (def! '<= <=) (def! '>= >=)

  ;; pair / list
  (def! 'cons cons) (def! 'car car) (def! 'cdr cdr)
  (def! 'caar caar) (def! 'cadr cadr) (def! 'cddr cddr) (def! 'caddr caddr)
  (def! 'list list)
  (def! 'null? null?) (def! 'pair? pair?) (def! 'list? list?)

  ;; 谓词 / 等价
  (def! 'eq? eq?) (def! 'eqv? eqv?) (def! 'equal? equal?)
  (def! 'not (lambda (x) (eq? x #f)))
  (def! 'symbol? symbol?) (def! 'string? string?) (def! 'boolean? boolean?)
  (def! 'procedure? (lambda (x) (or (closure? x) (primitive? x) (continuation? x))))

  ;; 状态检查点(全局环境快照)。restore 是整体替换:
  ;; capture 之后新增的顶层绑定会被回滚掉(真正的事务语义)。
  (def! 'capture (lambda () (checkpoint (hash-copy (env-vars g)))))
  (def! 'restore (lambda (cp)
                   (set-env-vars! g (hash-copy (checkpoint-vars cp)))
                   (void)))

  ;; 字符串
  (def! 'string-append string-append)
  (def! 'string-length string-length)
  (def! 'number->string number->string)
  (def! 'string->symbol string->symbol)
  (def! 'symbol->string symbol->string)

  ;; I/O
  (def! 'display (lambda (x) (display x) (void)))
  (def! 'write   (lambda (x) (write x) (void)))
  (def! 'newline (lambda () (newline) (void)))
  (def! 'error   (lambda args (apply error 'piper args)))

  ;; LLM 接入(M2):llm 原始补全、llm-code 生成 s-expr、eval 生成即运行
  (def! 'llm (case-lambda
               [(p)     (llm-call p)]
               [(p s)   (llm-call p s)]
               [(p s m) (llm-call p s m)]))
  (def! 'llm-code (case-lambda
                    [(p)   (llm-code-call p)]
                    [(p m) (llm-code-call p m)]))
  ;; eval:在全局环境求值一棵 s-expr(支持显式传 env)。
  ;; 注意:M2 的 current-env 简化为全局环境(原语看不到调用者词法环境)。
  (def! 'eval (case-lambda
                [(e)    (peval e g)]
                [(e ev) (peval e ev)]))
  (def! 'current-env (lambda () g))

  g)

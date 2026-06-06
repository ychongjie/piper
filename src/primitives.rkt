#lang racket/base

;; 原语过程:把宿主 Racket 过程包成 Piper primitive,装进全局环境。
;; 只放最小的不可约原语;list/map/filter 等高阶或可派生的工具
;; 用 Piper 自身写在 lib/prelude.piper 里(以此检验求值器)。

(require racket/port racket/string "env.rkt" "eval.rkt" "llm.rkt")
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
  (def! 'caar caar) (def! 'cadr cadr) (def! 'cddr cddr)
  (def! 'caddr caddr) (def! 'cadddr cadddr) (def! 'cdaddr cdaddr)
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
  (def! 'string->number string->number)        ; 非数字返回 #f
  (def! 'string->symbol string->symbol)
  (def! 'symbol->string symbol->string)
  (def! 'string->list string->list)
  (def! 'list->string list->string)
  (def! 'substring substring)
  (def! 'string-ref string-ref)
  (def! 'string=? string=?)
  (def! 'string-trim string-trim)
  ;; fmt:模板插值,把每个 {} 依次替换成参数(取代啰嗦的 string-append)
  (def! 'fmt
        (lambda (tmpl . args)
          (let loop ([ps (string-split tmpl "{}" #:trim? #f)] [as args] [acc ""])
            (cond
              [(null? ps) acc]
              [(null? (cdr ps)) (string-append acc (car ps))]
              [else (loop (cdr ps)
                          (if (null? as) '() (cdr as))
                          (string-append acc (car ps)
                                         (if (null? as) "" (format "~a" (car as)))))]))))
  ;; 把字符串安全地包成单引号 shell 参数(供 shell 调真 harness/工具用)
  (def! 'shell-quote (lambda (s) (string-append "'" (string-replace s "'" "'\\''") "'")))

  ;; 字符
  (def! 'char->integer char->integer)
  (def! 'integer->char integer->char)
  (def! 'char=? char=?)
  (def! 'char<? char<?) (def! 'char>? char>?)
  (def! 'char<=? char<=?) (def! 'char>=? char>=?)
  (def! 'char-numeric? char-numeric?)
  (def! 'char-whitespace? char-whitespace?)

  ;; I/O
  (def! 'display (lambda (x) (display x) (void)))
  (def! 'write   (lambda (x) (write x) (void)))
  (def! 'newline (lambda () (newline) (void)))
  (def! 'error   (lambda args (apply error 'piper args)))

  ;; 真实世界原语(编排器:让 worker 能是真实 harness / 工具 / 文件)。
  ;; 注意:这些是"危险原语",不在 eval-in 沙箱里,LLM/自修改代码默认碰不到。
  (def! 'shell                ; 跑一条 shell 命令,返回 (退出码 . stdout+stderr)
        (lambda (cmd)
          (define-values (sp out in err) (subprocess #f #f #f "/bin/sh" "-c" cmd))
          (close-output-port in)
          (define o (port->string out))
          (define e (port->string err))
          (subprocess-wait sp)
          (close-input-port out) (close-input-port err)
          (cons (subprocess-status sp) (string-append o e))))
  (def! 'read-file  (lambda (path) (call-with-input-file path port->string)))
  (def! 'write-file (lambda (path s)
                      (call-with-output-file path
                        (lambda (p) (display s p)) #:exists 'replace)
                      (void)))
  (def! 'file-exists? file-exists?)

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

  ;; eval-in(M4 能力白名单沙箱):在一个**只含指定绑定**的隔离环境里求值
  ;; expr(无 parent,故只有 alist 里的工具 + 句法特殊形式可用,碰不到 +/car/
  ;; llm/redefine 等),并捕获错误。alist 是 ((name . proc) ...)。
  ;; 返回 (ok . value) 或 (err . message),供 goal driver 判定与回滚。
  (def! 'eval-in
        (lambda (expr alist)
          (define e (make-env))
          (let bind ([a alist])
            (unless (null? a)
              (env-define! e (caar a) (cdar a))
              (bind (cdr a))))
          (with-handlers ([exn:fail? (lambda (ex) (cons 'err (exn-message ex)))])
            (cons 'ok (peval expr e)))))

  ;; try:安全调用一个 0 参 thunk,捕获错误。返回 (ok . value) | (err . message)。
  ;; 自修改的安全网:坏的重定义可能让冒烟测试本身抛错,improve! 用它把"抛错"也当失败。
  (def! 'try (lambda (thunk)
               (with-handlers ([exn:fail? (lambda (ex) (cons 'err (exn-message ex)))])
                 (cons 'ok (papply thunk '())))))

  ;; 渲染:把任意值/ s-expr 转成字符串(喂 prompt 用)
  (def! '->string (lambda (x) (format "~a" x)))   ; display 风格
  (def! 'repr     (lambda (x) (format "~s" x)))   ; write 风格(适合 s-expr)

  ;; 宿主定时器(M5 loop 的 #:every / self-paced delay 用)
  (def! 'sleep (lambda (secs) (sleep secs) (void)))

  ;; ---- M6:运行时自修改 ----

  ;; procedure-source:同像性兑现 —— 闭包的源就是 s-expr。
  ;; 闭包 -> (lambda <params> body...);原语 -> (primitive name);其它 -> 原值
  (define (proc-source v)
    (cond [(closure? v)   (cons 'lambda (cons (closure-params v) (closure-body v)))]
          [(primitive? v) (list 'primitive (primitive-name v))]
          [else v]))
  (def! 'procedure-source proc-source)

  ;; 核心保护:这些绑定关系到自修改/事务的安全,redefine! 默认拒绝改写
  (define protected
    '(redefine! force-redefine! restore capture eval eval-in
      procedure-source redefine-log protected?))
  (def! 'protected? (lambda (name) (and (memq name protected) #t)))

  ;; 审计日志(append-only,本解释器私有,restore 不会清掉它)
  (define audit '())   ; 新的在前
  (define seq 0)
  (define (do-redefine! force? name newval reason)
    (unless (symbol? name) (error 'redefine! "名字必须是符号: ~s" name))
    (when (and (not force?) (memq name protected))
      (error 'redefine! "拒绝改写受保护的核心绑定: ~a(如确需请用 force-redefine!)" name))
    (define old (if (hash-has-key? (env-vars g) name)
                    (hash-ref (env-vars g) name) 'undefined))
    (set! seq (add1 seq))
    (set! audit (cons (list seq name (proc-source old) (proc-source newval) reason) audit))
    (env-define! g name newval)
    name)
  (def! 'redefine! (case-lambda
                     [(n v)   (do-redefine! #f n v "")]
                     [(n v r) (do-redefine! #f n v r)]))
  (def! 'force-redefine! (case-lambda
                           [(n v)   (do-redefine! #t n v "")]
                           [(n v r) (do-redefine! #t n v r)]))
  (def! 'redefine-log (lambda () (reverse audit)))   ; 最早在前

  g)

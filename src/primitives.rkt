#lang racket/base

;; 原语过程:把宿主 Racket 过程包成 Piper primitive,装进全局环境。
;; 只放最小的不可约原语;list/map/filter 等高阶或可派生的工具
;; 用 Piper 自身写在 lib/prelude.piper 里(以此检验求值器)。

(require "env.rkt" "eval.rkt")
(provide make-global-env)

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
  (def! 'procedure? (lambda (x) (or (closure? x) (primitive? x))))

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

  g)

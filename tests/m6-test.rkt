#lang racket/base

;; M6 测试:redefine! 运行时自修改 + procedure-source + 审计 + 安全 + 事务。
;; improve! 用 mock LLM。运行:raco test tests/m6-test.rkt

(require rackunit "../src/interp.rkt" "../src/llm.rkt")

(define (E s) (eval-string s (make-interpreter)))
(define (run mock s)
  (parameterize ([current-llm (lambda (p sy m) mock)])
    (eval-string s (make-interpreter))))

;; ---- procedure-source:同像性,取回闭包源 ----
(check-equal? (E "(define (sq x) (* x x)) (procedure-source sq)")
              '(lambda (x) (* x x)))
(check-equal? (E "(procedure-source (lambda (a b) (+ a b) a))")
              '(lambda (a b) (+ a b) a))

;; ---- redefine!:改写全局绑定 ----
(check-equal? (E "(define (f) 1) (redefine! 'f (lambda () 2)) (f)") 2)

;; ---- 审计日志 ----
(check-equal?
 (E "(define (f) 1)
     (redefine! 'f (lambda () 2) \"bump\")
     (length (redefine-log))")
 1)
(check-equal?
 (E "(define (f) 1)
     (redefine! 'f (lambda () 2) \"bump\")
     (let ((rec (car (redefine-log))))
       (list (cadr rec) (caddr rec) (cadddr rec)))")   ; (name old-src new-src)
 '(f (lambda () 1) (lambda () 2)))

;; ---- 安全模型:核心绑定受保护 ----
(check-equal? (E "(protected? 'restore)") #t)
(check-equal? (E "(protected? 'sq)") #f)
(check-exn exn:fail? (lambda () (E "(redefine! 'restore 1)")))      ; 拒绝
(check-equal? (E "(force-redefine! 'eval (lambda (x) x))") 'eval)   ; 显式强制可绕过

;; ---- 事务:redefine 后 restore 回滚 ----
(check-equal?
 (E "(define (f) 1) (define cp (capture)) (redefine! 'f (lambda () 2)) (restore cp) (f)")
 1)

;; ---- improve!:LLM 修好一个有 bug 的过程(冒烟通过 -> kept)----
(check-equal?
 (run "(lambda (x) (* x x))"
      "(define (sq x) (+ x x))                       ; bug:本应平方
       (define r (improve! 'sq \"应返回平方\" (lambda () (= (sq 5) 25))))
       (list r (sq 5))")
 '(kept 25))

;; ---- improve!:冒烟不过 -> 整体回滚,过程保持原样 ----
(check-equal?
 (run "(lambda (x) 'broken)"
      "(define (sq x) (* x x))                       ; 本来是对的
       (define r (improve! 'sq \"乱改\" (lambda () (= (sq 5) 25))))
       (list r (sq 5))")                              ; 新实现冒烟不过 -> 回滚
 '(rolled-back 25))

;; 即便回滚,尝试也进了审计日志
(check-equal?
 (run "(lambda (x) 'broken)"
      "(define (sq x) (* x x))
       (improve! 'sq \"乱改\" (lambda () #f))
       (length (redefine-log))")
 1)

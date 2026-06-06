#lang racket/base

;; M1 测试:call/cc(一等 continuation)+ capture/restore(状态检查点)。
;; 运行:raco test tests/m1-test.rkt

(require rackunit "../src/interp.rkt")

(define (E s) (eval-string s (make-interpreter)))

;; ---- call/cc:正常返回(k 未被调用) ----
(check-equal? (E "(call/cc (lambda (k) 99))") 99)
(check-equal? (E "(+ 1 (call/cc (lambda (k) 10)))") 11)

;; ---- call/cc:非局部退出(early return) ----
(check-equal? (E "(call/cc (lambda (return) (+ 1 (return 42))))") 42)
(check-equal? (E "(call-with-current-continuation (lambda (k) (* 2 (k 5))))") 5)

;; ---- call/cc:从循环里提前逃逸 ----
(check-equal?
 (E "(define (product xs)
       (call/cc (lambda (break)
         (foldl (lambda (x acc) (if (= x 0) (break 0) (* x acc))) 1 xs))))
     (product '(1 2 3 4))")
 24)
(check-equal?
 (E "(define (product xs)
       (call/cc (lambda (break)
         (foldl (lambda (x acc) (if (= x 0) (break 0) (* x acc))) 1 xs))))
     (product '(1 2 0 4))")          ; 遇 0 立刻 break,不再相乘
 0)

;; ---- call/cc:多次重入(multi-shot,generator/loop 的基础) ----
;; 保存续延 k,反复跳回,累加 count 直到 v 到 3。
(check-equal?
 (E "(begin
       (define k #f)
       (define count 0)
       (define v (call/cc (lambda (c) (set! k c) 0)))
       (set! count (add1 count))
       (if (< v 3) (k (add1 v)) count))")
 4)

;; ---- capture / restore:set! 回滚 ----
(check-equal?
 (E "(begin (define x 1) (define cp (capture)) (set! x 100) (restore cp) x)")
 1)

;; ---- capture / restore:重定义回滚(事务性自修改的雏形) ----
(check-equal?
 (E "(begin (define (f) 1) (define cp (capture)) (define (f) 2) (restore cp) (f))")
 1)

;; 不 restore 则改动生效
(check-equal?
 (E "(begin (define (f) 1) (define cp (capture)) (define (f) 2) (f))")
 2)

;; restore 是整体替换:capture 之后新增的顶层绑定被回滚掉,引用它会未绑定
(check-equal?
 (E "(begin (define cp (capture)) (define y 7) y)")   ; 不回滚:y 可见
 7)
(check-exn exn:fail?
 (lambda ()
   (E "(begin (define cp (capture)) (define y 7) (restore cp) y)")))  ; 回滚后 y 没了

;; ---- continuation 是 procedure ----
(check-equal? (E "(call/cc (lambda (k) (procedure? k)))") #t)

#lang racket/base

;; M3 测试:define-macro(宏设施)+ amb / require(回溯)。
;; 运行:raco test tests/m3-test.rkt

(require rackunit "../src/interp.rkt")

(define (E s) (eval-string s (make-interpreter)))

;; ---- define-macro:最小宏设施 ----
;; swap-style:(my-if c a b) -> (cond (c a) (else b))
(check-equal?
 (E "(define-macro (my-if c a b) (list 'cond (list c a) (list 'else b)))
     (my-if (> 3 2) 'yes 'no)")
 'yes)
;; 宏拿到的是未求值的形式:(twice e) -> (begin e e)
(check-equal?
 (E "(define-macro (inc-twice v) (list 'begin (list 'set! v (list 'add1 v))
                                                (list 'set! v (list 'add1 v))))
     (define n 0) (inc-twice n) n")
 2)

;; ---- amb / require:基本选择 ----
(check-equal? (E "(define x (amb 1 2 3)) (require (= x 2)) x") 2)
(check-equal? (E "(amb 1 2 3)") 1)                  ; 不加约束取第一个

;; ---- 跨多个 amb 的回溯(求和约束) ----
(check-equal?
 (E "(define a (amb 1 2 3))
     (define b (amb 10 20 30))
     (require (= (+ a b) 31))
     (list a b)")
 '(1 30))

;; ---- 经典:勾股数 ----
(check-equal?
 (E "(define (pythag hi)
       (let ((i (an-integer-between 1 hi)))
         (let ((j (an-integer-between i hi)))
           (let ((k (an-integer-between j hi)))
             (require (= (+ (* i i) (* j j)) (* k k)))
             (list i j k)))))
     (pythag 20)")
 '(3 4 5))

;; ---- amb*:在运行时列表(模拟 LLM 候选)间选择 ----
(check-equal?
 (E "(define s (amb* (list 'merge 'rebase 'squash)))
     (require (eq? s 'rebase))
     s")
 'rebase)

;; ---- 耗尽即报错 ----
(check-exn exn:fail? (lambda () (E "(amb)")))                    ; 无候选
(check-exn exn:fail? (lambda () (E "(define x (amb 1 2)) (require (> x 9)) x")))

;; ---- 回溯不破坏后续普通求值(同一解释器内 amb 用尽后仍可算别的) ----
(check-equal?
 (E "(define r (call/cc (lambda (k)
                  (set! *amb-fail* (cons (lambda () (k 'no-solution)) *amb-fail*))
                  (let ((x (amb 1 2)))
                    (require (> x 9))
                    x))))
     r")
 'no-solution)

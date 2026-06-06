#lang racket/base

;; 编排组合子的确定性测试(worker 用普通 thunk,不打网络)。
;; 运行:raco test tests/orchestrate-test.rkt

(require rackunit "../src/interp.rkt")

(define (E s) (eval-string s (make-interpreter)))

;; ---- fanout:跑一组 worker 收集结果 ----
(check-equal? (E "(fanout (list (lambda () 1) (lambda () 2) (lambda () 3)))") '(1 2 3))

;; ---- best-of:按 score 选最优 ----
(check-equal?
 (E "(best-of (list (lambda () 3) (lambda () 7) (lambda () 5)) (lambda (x) x))")
 7)
;; score 取负 -> 选最小
(check-equal?
 (E "(best-of (list (lambda () 3) (lambda () 7) (lambda () 5)) (lambda (x) (- 0 x)))")
 3)

;; ---- vote:多数表决 ----
(check-equal?
 (E "(vote (list (lambda () 'a) (lambda () 'b) (lambda () 'a) (lambda () 'a)))")
 'a)

;; ---- first-ok:取第一个满足谓词的 ----
(check-equal?
 (E "(first-ok (list (lambda () 1) (lambda () 2) (lambda () 5)) (lambda (x) (> x 2)))")
 5)
(check-equal?
 (E "(first-ok (list (lambda () 1) (lambda () 2)) (lambda (x) (> x 9)))")
 #f)

;; ---- retry:反复试到通过 ----
(check-equal?
 (E "(define n 0)
     (retry (lambda () (set! n (add1 n)) n) (lambda (r) (>= r 3)) 10)")
 3)

;; ---- pipeline:依次穿过各 stage ----
(check-equal?
 (E "(pipeline 5 (list (lambda (x) (+ x 1)) (lambda (x) (* x 2)) (lambda (x) (- x 3))))")
 9)

;; ---- 辅助:best-by / tally ----
(check-equal? (E "(best-by (list 1 5 3) (lambda (x) x))") 5)
(check-equal? (E "(tally (list 'a 'b 'a))") '((b . 1) (a . 2)))

;; ---- 真实世界原语:shell ----
(check-equal? (E "(car (shell \"exit 0\"))") 0)
(check-equal? (E "(car (shell \"exit 3\"))") 3)
(check-equal? (E "(cdr (shell \"printf hello\"))") "hello")

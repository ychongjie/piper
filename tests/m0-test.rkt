#lang racket/base

;; M0 求值器测试。运行:raco test tests/m0-test.rkt

(require rackunit "../src/interp.rkt")

;; 每个用例用全新解释器,避免顶层 define 互相污染
(define (E s)
  (eval-string s (make-interpreter)))

;; ---- 自求值 / 基本算术 ----
(check-equal? (E "42") 42)
(check-equal? (E "(+ 1 2 3)") 6)
(check-equal? (E "(- 10 3 2)") 5)
(check-equal? (E "(* 2 (+ 3 4))") 14)
(check-equal? (E "\"hi\"") "hi")
(check-equal? (E "#t") #t)

;; ---- quote ----
(check-equal? (E "'(1 2 3)") '(1 2 3))
(check-equal? (E "'foo") 'foo)
(check-equal? (E "'()") '())

;; ---- if / cond / and / or ----
(check-equal? (E "(if #t 1 2)") 1)
(check-equal? (E "(if #f 1 2)") 2)
(check-equal? (E "(if (> 3 2) 'yes 'no)") 'yes)
(check-equal? (E "(cond ((= 1 2) 'a) ((= 1 1) 'b) (else 'c))") 'b)
(check-equal? (E "(cond (#f 'a) (else 'c))") 'c)
(check-equal? (E "(and 1 2 3)") 3)
(check-equal? (E "(and 1 #f 3)") #f)
(check-equal? (E "(or #f #f 7)") 7)
(check-equal? (E "(or #f #f)") #f)

;; ---- define / lambda / 闭包 ----
(check-equal? (E "(define (sq x) (* x x)) (sq 5)") 25)
(check-equal? (E "(define (add a b) (+ a b)) (add 3 4)") 7)
(check-equal? (E "((lambda (x) (* x x)) 6)") 36)

;; 递归:阶乘
(check-equal? (E "(define (fact n) (if (= n 0) 1 (* n (fact (- n 1))))) (fact 5)") 120)

;; 闭包捕获:make-counter via set!
(check-equal?
 (E "(define (make-adder n) (lambda (x) (+ x n)))
     (define add10 (make-adder 10))
     (add10 5)")
 15)

;; set! 改写
(check-equal? (E "(define x 1) (set! x (+ x 9)) x") 10)

;; ---- let ----
(check-equal? (E "(let ((a 2) (b 3)) (+ a b))") 5)
(check-equal? (E "(let ((x 10)) (let ((y 20)) (+ x y)))") 30)

;; ---- 变参 lambda ----
(check-equal? (E "((lambda args args) 1 2 3)") '(1 2 3))
(check-equal? (E "((lambda (a . rest) rest) 1 2 3)") '(2 3))

;; ---- prelude:高阶 / 列表 ----
(check-equal? (E "(map (lambda (x) (* x x)) '(1 2 3 4))") '(1 4 9 16))
(check-equal? (E "(filter (lambda (x) (> x 2)) '(1 2 3 4))") '(3 4))
(check-equal? (E "(foldl + 0 '(1 2 3 4 5))") 15)
(check-equal? (E "(length '(a b c d))") 4)
(check-equal? (E "(append '(1 2) '(3 4))") '(1 2 3 4))
(check-equal? (E "(reverse '(1 2 3))") '(3 2 1))
(check-equal? (E "(range 5)") '(0 1 2 3 4))
(check-equal? (E "(member 3 '(1 2 3 4))") '(3 4))
(check-equal? (E "(assoc 'b '((a 1) (b 2)))") '(b 2))

;; ---- 错误处理 ----
(check-exn exn:fail? (lambda () (E "undefined-var")))
(check-exn exn:fail? (lambda () (E "(car '())")))

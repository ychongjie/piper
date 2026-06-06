#lang racket/base

;; 控制平面组合子测试(worker 用普通 (lambda (task) …),不打网络)。
;; 运行:raco test tests/orchestrate-test.rkt

(require rackunit "../src/interp.rkt")
(define (E s) (eval-string s (make-interpreter)))

;; ---- fan-out:一组 worker 各做同一 task,收集结果 ----
(check-equal? (E "(fan-out (list (lambda (t) 1) (lambda (t) 2) (lambda (t) 3)) 'q)") '(1 2 3))
;; worker 能拿到 task
(check-equal? (E "(fan-out (list (lambda (t) t) (lambda (t) (list 'got t))) 'hi)")
              '(hi (got hi)))

;; ---- best:按 score 取最优 ----
(check-equal? (E "(best (list (lambda (t) 3) (lambda (t) 7) (lambda (t) 5)) 'q (lambda (x) x))") 7)
(check-equal? (E "(best (list (lambda (t) 3) (lambda (t) 7)) 'q (lambda (x) (- 0 x)))") 3)

;; ---- vote:多数表决 ----
(check-equal?
 (E "(vote (list (lambda (t) 'a) (lambda (t) 'b) (lambda (t) 'a) (lambda (t) 'a)) 'q)")
 'a)

;; ---- 内部小工具 ----
(check-equal? (E "(best-by (list 1 5 3) (lambda (x) x))") 5)
(check-equal? (E "(tally (list 'a 'b 'a))") '((b . 1) (a . 2)))

;; ---- read-files:控制平面读本地代码(供喂进认知层 prompt)----
(check-equal?
 (E "(begin (shell \"printf hello > /tmp/piper-rf.txt\")
            (define s (read-files (list \"/tmp/piper-rf.txt\")))
            (list (string? s) (> (string-length s) 5)))")
 '(#t #t))

;; ---- shell ----
(check-equal? (E "(car (shell \"exit 0\"))") 0)
(check-equal? (E "(car (shell \"exit 4\"))") 4)
(check-equal? (E "(cdr (shell \"printf done\"))") "done")

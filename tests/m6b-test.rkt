#lang racket/base

;; 失败驱动 evolve! 的确定性测试(脚本化 mock,不打真网络)。
;; 运行:raco test tests/m6b-test.rkt

(require rackunit "../src/interp.rkt" "../src/llm.rkt")

(define (run mock-steps src)
  (define steps mock-steps)
  (parameterize ([current-llm (lambda (p s m)
                                (let ([x (car steps)]) (set! steps (cdr steps)) x))])
    (eval-string src (make-interpreter))))

(define CASES "(define cases (list (list 1 2) (list 2 4) (list 3 6)))")  ; 应翻倍

;; ---- 已经正确 -> 0 轮就 evolved ----
(check-equal?
 (run '()
      (string-append "(define (f x) (* x 2))" CASES
                     "(evolve! 'f cases \"翻倍\" 5)"))
 '(evolved 0))

;; ---- 两轮收敛:先部分修复(+1),再完全修复(*2)----
(check-equal?
 (run (list "(lambda (x) (+ x 1))"     ; f(1)=2✓ f(2)=3✗ f(3)=4✗ -> 失败 3->2,保留
            "(lambda (x) (* x 2))")    ; 全过 -> evolved
      (string-append "(define (f x) x)" CASES
                     "(evolve! 'f cases \"翻倍\" 5)"))
 '(evolved 2))

;; 进化后函数确实被改对
(check-equal?
 (run (list "(lambda (x) (+ x 1))" "(lambda (x) (* x 2))")
      (string-append "(define (f x) x)" CASES
                     "(evolve! 'f cases \"翻倍\" 5) (f 5)"))
 10)

;; ---- 退步回滚:更差的候选被丢弃,原实现保留 ----
(check-equal?
 (run (list "(lambda (x) 0)")          ; 全错(3 失败)比原来(2 失败)差 -> 回滚
      (string-append "(define (f x) (+ x 1))" CASES   ; 原本 2 个失败
                     "(evolve! 'f cases \"翻倍\" 1) (f 1)"))  ; 回滚后 f(1) 仍 = 2
 2)

;; ---- 用尽轮数仍未全过 -> partial ----
(check-equal?
 (car (run (list "(lambda (x) (+ x 1))")
           (string-append "(define (f x) x)" CASES
                          "(evolve! 'f cases \"翻倍\" 1)")))
 'partial)

;; ---- 候选抛错也算失败(被 try 兜住),不崩 ----
(check-equal?
 (run (list "(lambda (x) (car x))"     ; (car 1) 抛错 -> 该用例 ERROR,失败数不减 -> 回滚
            "(lambda (x) (* x 2))")    ; 再修对
      (string-append "(define (f x) x)" CASES
                     "(car (evolve! 'f cases \"翻倍\" 3))"))
 'evolved)

;; ---- 新增字符串/字符原语可用 ----
(check-equal? (run '() "(string->number \"42\")") 42)
(check-equal? (run '() "(string->list \"ab\")") '(#\a #\b))
(check-equal? (run '() "(char-numeric? #\\7)") #t)
(check-equal? (run '() "(substring \"hello\" 1 3)") "el")

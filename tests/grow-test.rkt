#lang racket/base

;; 自我生长程序的确定性测试(脚本化 mock)。运行:raco test tests/grow-test.rkt

(require rackunit "../src/interp.rkt" "../src/llm.rkt")

(define (run mock-steps src)
  (define steps mock-steps)
  (parameterize ([current-llm (lambda (p s m)
                                (let ([x (car steps)]) (set! steps (cdr steps)) x))])
    (eval-string src (make-interpreter))))

;; ---- 学会一个技能后可调用,并进注册表 ----
(check-equal?
 (run (list "(define (greet n) (string-append \"hi \" n))")
      "(learn! 'greet \"问候\" (lambda () (string=? (greet \"A\") \"hi A\")) 3)
       (greet \"Bob\")")
 "hi Bob")

(check-equal?
 (run (list "(define (greet n) (string-append \"hi \" n))")
      "(learn! 'greet \"问候\" (lambda () #t) 3) (skill-names)")
 '(greet))

;; ---- 复利:第二个技能调用第一个(组合)----
(check-equal?
 (run (list "(define (greet n) (string-append \"hi \" n))"
            "(define (greet-all xs) (map greet xs))")     ; 复用 greet
      "(learn! 'greet \"问候\" (lambda () #t) 3)
       (learn! 'greet-all \"批量问候\" (lambda () (equal? (greet-all (list \"A\" \"B\"))
                                                          (list \"hi A\" \"hi B\"))) 3)
       (greet-all (list \"X\" \"Y\"))")
 '("hi X" "hi Y"))

;; ---- 验收不过 -> 重试,第二次写对 ----
(check-equal?
 (run (list "(define (sq x) (+ x x))"      ; 错:第一次验收不过 -> 回滚重试
            "(define (sq x) (* x x))")     ; 对
      "(learn! 'sq \"平方\" (lambda () (= (sq 5) 25)) 3) (sq 6)")
 36)

;; ---- 用尽次数仍不过 -> failed,镜像不被污染(skill 未定义、注册表为空)----
(check-equal?
 (run (list "(define (sq x) (+ x x))" "(define (sq x) (+ x x))" "(define (sq x) (+ x x))")
      "(list (learn! 'sq \"平方\" (lambda () (= (sq 5) 25)) 3) (skill-names))")
 '(failed ()))

;; 失败回滚后,坏技能确实没留在镜像里(引用即未绑定)
(check-exn exn:fail?
 (lambda ()
   (run (list "(define (sq x) (+ x x))" "(define (sq x) (+ x x))" "(define (sq x) (+ x x))")
        "(learn! 'sq \"平方\" (lambda () (= (sq 5) 25)) 3) (sq 9)")))

;; ---- 同像性自省:skills->string 含已学技能的源码 ----
(check-equal?
 (run (list "(define (greet n) (string-append \"hi \" n))")
      "(learn! 'greet \"问候\" (lambda () #t) 3)
       (if (> (string-length (skills->string)) 10) 'has-source 'empty)")
 'has-source)

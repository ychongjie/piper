#lang racket/base

;; M4 测试:goal —— LLM 驱动的目标循环。用脚本化 mock,不打真网络。
;; (真实 LLM 端到端见 examples/goal.piper)
;; 运行:raco test tests/m4-test.rkt

(require rackunit "../src/interp.rkt" "../src/llm.rkt")

;; 脚本化 mock:依次返回给定的若干"下一步",用尽后返回一个无效步
(define (scripted . steps)
  (define remaining steps)
  (lambda (prompt system model)
    (cond [(null? remaining) "(no-such-tool)"]
          [else (define x (car remaining))
                (set! remaining (cdr remaining))
                x])))

(define (run mock src)
  (parameterize ([current-llm mock])
    (eval-string src (make-interpreter))))

;; 公共 setup:total + add 工具(每步只能 +,且 ≤10)
(define SETUP
  "(define total 0)
   (define (add n) (if (> n 10) (error \"too big\") (begin (set! total (+ total n)) total)))")

;; ---- 成功:多步累加到目标 ----
(check-equal?
 (run (scripted "(add 10)" "(add 10)" "(add 3)")
      (string-append SETUP
       "(goal \"让 total 等于 23\"
          (success? (lambda () (= total 23)))
          (tools (list (cons 'add add)))
          (max-steps 6))
        total"))
 23)

;; 返回值带 success 标签
(check-equal?
 (car (run (scripted "(add 10)" "(add 10)" "(add 3)")
           (string-append SETUP
            "(goal \"到 23\"
               (success? (lambda () (= total 23)))
               (tools (list (cons 'add add)))
               (max-steps 6))")))
 'success)

;; ---- 步数耗尽 ----
(check-equal?
 (car (run (scripted "(add 1)" "(add 1)")
           (string-append SETUP
            "(goal \"到 1000(不可能)\"
               (success? (lambda () (= total 1000)))
               (tools (list (cons 'add add)))
               (max-steps 3))")))
 'exhausted)

;; ---- 能力白名单:LLM 想直接 set! total 改不到(total 不在白名单)----
;; 每步都被沙箱拦下并回滚,total 始终 0,最终 exhausted
(check-equal?
 (run (scripted "(set! total 23)" "(set! total 23)" "(set! total 23)")
      (string-append SETUP
       "(goal \"绕过工具直接改 total\"
          (success? (lambda () (= total 23)))
          (tools (list (cons 'add add)))
          (max-steps 3))
        total"))
 0)

;; ---- 能力白名单:LLM 想用未授权原语(+ / car)也被拦 ----
(check-equal?
 (car (run (scripted "(+ total 23)" "(car (list 1 2))")
           (string-append SETUP
            "(goal \"用未授权函数\"
               (success? (lambda () (= total 23)))
               (tools (list (cons 'add add)))
               (max-steps 2))")))
 'exhausted)

;; ---- 出错步被回滚:坏步(>10)不改 total,后续好步仍能达成 ----
(check-equal?
 (run (scripted "(add 99)" "(add 5)" "(add 5)")    ; 第一步 >10 报错被回滚
      (string-append SETUP
       "(goal \"到 10\"
          (success? (lambda () (= total 10)))
          (tools (list (cons 'add add)))
          (max-steps 6))
        total"))
 10)

;; ---- L2 driver 也可直接调用(不经宏)----
(check-equal?
 (car (run (scripted "(add 10)")
           (string-append SETUP
            "(goal-run \"到 10\" (lambda () (= total 10))
                       (list (cons 'add add)) 4)")))
 'success)

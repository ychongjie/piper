#lang racket/base

;; worker 适配器 + 在 task 上调度的测试。mock 按"模型名"返回不同答案,
;; 模拟一个多模型评审团,确定性、不打网络。运行:raco test tests/workers-test.rkt

(require rackunit "../src/interp.rkt" "../src/llm.rkt")

;; mock:按 model 参数返回不同结果(模拟不同开源模型)
(define (E/models table src)
  (parameterize ([current-llm (lambda (prompt system model)
                                (cond [(assoc model table) => cdr]
                                      [else "?"]))])
    (eval-string src (make-interpreter))))

;; ---- llm-worker:指定模型 ----
(check-equal?
 (E/models '(("m1" . "hello"))
           "((llm-worker \"m1\") \"任意问题\")")
 "hello")

;; ---- ask-all:fan-out 到一组模型,收集各自答案 ----
(check-equal?
 (E/models '(("a" . "答A") ("b" . "答B") ("c" . "答C"))
           "(ask-all \"Q\" (model-workers (list \"a\" \"b\" \"c\")))")
 '("答A" "答B" "答C"))

;; ---- vote-on:多数表决(两个模型一致 -> 胜出)----
(check-equal?
 (E/models '(("a" . "yes") ("b" . "no") ("c" . "yes"))
           "(vote-on \"Q\" (model-workers (list \"a\" \"b\" \"c\")))")
 "yes")

;; ---- best-on:按裁判分择优(这里裁判=答案长度,选最长)----
(check-equal?
 (E/models '(("a" . "x") ("b" . "xxxxx") ("c" . "xx"))
           "(best-on \"Q\" (model-workers (list \"a\" \"b\" \"c\"))
                     (lambda (ans) (string-length ans)))")
 "xxxxx")

;; ---- shell-quote:安全包裹(含单引号)----
(check-equal? (E/models '() "(shell-quote \"hi\")") "'hi'")
(check-equal? (E/models '() "(shell-quote \"it's\")") "'it'\\''s'")

;; ---- shell-quote 真能安全传给 shell(回显原文)----
(check-equal?
 (E/models '() "(cdr (shell (string-append \"printf %s \" (shell-quote \"a'b c\"))))")
 "a'b c")

;; ---- string-trim ----
(check-equal? (E/models '() "(string-trim \"  8  \")") "8")

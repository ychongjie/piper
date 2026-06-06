#lang racket/base

;; 认知层测试 + 与控制平面咬合(model 当 worker、judge 当 score、propose 当候选)。
;; mock 不打网络。运行:raco test tests/cognition-test.rkt

(require rackunit "../src/interp.rkt" "../src/llm.rkt")

;; mock:按 model 参数返回不同答案(模拟不同模型)
(define (E/models table src)
  (parameterize ([current-llm (lambda (prompt system model)
                                (cond [(assoc model table) => cdr] [else "?"]))])
    (eval-string src (make-interpreter))))
;; mock:按 prompt 是否含子串返回
(define (E/prompt rules src)
  (parameterize ([current-llm (lambda (prompt system model)
                                (let loop ((rs rules))
                                  (cond [(null? rs) "0"]
                                        [(regexp-match? (regexp (caar rs)) prompt) (cdar rs)]
                                        [else (loop (cdr rs))])))])
    (eval-string src (make-interpreter))))
;; mock:恒定返回
(define (E/const out src)
  (parameterize ([current-llm (lambda (p s m) out)])
    (eval-string src (make-interpreter))))

;; ---- model:认知 worker(双模式)----
(check-equal? (E/models '(("m1" . "hi")) "((model \"m1\") \"q\")") "hi")  ; 当 worker
(check-equal? (E/models '(("m1" . "hi")) "(model \"m1\" \"q\")") "hi")    ; 直接问一次

;; ---- best 接受标准字符串当 score(自动用 judge)----
;; mock:a/b 模型给答案,默认模型(judge)恒返回 9 → 平分,取第一个
(check-equal?
 (E/models '(("a" . "答A") ("b" . "答B") ("deepseek-v4-pro" . "9"))
           "(best (map model (list \"a\" \"b\")) \"q\" \"准确\")")
 "答A")

;; ---- model 与控制平面咬合:fan-out / vote 直接用 (map model …) ----
(check-equal?
 (E/models '(("a" . "答A") ("b" . "答B")) "(fan-out (map model (list \"a\" \"b\")) \"q\")")
 '("答A" "答B"))
(check-equal?
 (E/models '(("a" . "yes") ("b" . "no") ("c" . "yes"))
           "(vote (map model (list \"a\" \"b\" \"c\")) \"q\")")
 "yes")
;; best:model 当 worker,纯 score(避免再调 llm)
(check-equal?
 (E/models '(("a" . "x") ("b" . "xxxxx") ("c" . "xx"))
           "(best (map model (list \"a\" \"b\" \"c\")) \"q\" (lambda (a) (string-length a)))")
 "xxxxx")

;; ---- judge:0-10 裁判(给 best 当 score),解析失败记 0 ----
(check-equal? (E/prompt '(("." . "8")) "(judge \"准确\" \"某文本\")") 8)
(check-equal? (E/prompt '(("." . "满分")) "(judge \"准确\" \"x\")") 0)

;; ---- propose:返回候选 list(给 amb* 当搜索空间)----
(check-equal? (E/const "(list \"i1\" \"i2\" \"i3\")" "(propose 3 \"任务\")") '("i1" "i2" "i3"))
;; propose 喂给 amb* + require 回溯,选出满足条件的候选
(check-equal?
 (E/const "(list \"merge\" \"rebase\" \"squash\")"
          "(let ((x (amb* (propose 3 \"策略\")))) (require (string=? x \"rebase\")) x)")
 "rebase")

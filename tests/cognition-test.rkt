#lang racket/base

;; 认知层(llm)测试 + 认知↔执行 桥接的纯逻辑。mock 按模型/提示返回,确定性。
;; 运行:raco test tests/cognition-test.rkt

(require rackunit "../src/interp.rkt" "../src/llm.rkt")

;; mock:按 (model . 回复) 表返回;否则回退到一个默认
(define (E/models table src [fallback "?"])
  (parameterize ([current-llm (lambda (prompt system model)
                                (cond [(assoc model table) => cdr]
                                      [else fallback]))])
    (eval-string src (make-interpreter))))

;; mock:按"提示里是否包含某子串"返回(用于测 judge/decide 这种走默认模型的)
(define (E/prompt rules src)
  (parameterize ([current-llm (lambda (prompt system model)
                                (let loop ((rs rules))
                                  (cond [(null? rs) "0"]
                                        [(regexp-match? (regexp (caar rs)) prompt) (cdar rs)]
                                        [else (loop (cdr rs))])))])
    (eval-string src (make-interpreter))))

;; ---- ask-model:指定模型思考 ----
(check-equal? (E/models '(("m1" . "hi")) "(ask-model \"m1\" \"q\")") "hi")

;; ---- judge:解析 0-10 分;解析失败记 0 ----
(check-equal? (E/prompt '(("." . "8")) "(judge \"准确\" \"某回答\")") 8)
(check-equal? (E/prompt '(("." . "满分")) "(judge \"准确\" \"x\")") 0)  ; 非数字 -> 0

;; ---- decide:返回选中项(去空白)----
(check-equal? (E/prompt '(("." . "  B  ")) "(decide \"选哪个\" (list 'A 'B))") "B")

;; ---- ensemble:多模型各答一版 ----
(check-equal?
 (E/models '(("a" . "答A") ("b" . "答B") ("c" . "答C"))
           "(ensemble (list \"a\" \"b\" \"c\") \"Q\")")
 '("答A" "答B" "答C"))

;; ---- vote-ensemble:多数表决 ----
(check-equal?
 (E/models '(("a" . "yes") ("b" . "no") ("c" . "yes"))
           "(vote-ensemble (list \"a\" \"b\" \"c\") \"Q\")")
 "yes")

;; ---- 桥接(执行层 outcome 用认知层校验)----
(check-equal? (E/models '() "(agent-ok? (cons 0 \"done\"))") #t)
(check-equal? (E/models '() "(agent-ok? (cons 1 \"err\"))") #f)
(check-equal? (E/prompt '(("." . "9")) "(verify (cons 0 \"结果\") \"达标\")") #t)  ; 9>=7
(check-equal? (E/prompt '(("." . "5")) "(verify (cons 0 \"结果\") \"达标\")") #f)  ; 5<7

;; ---- shell-quote / string-trim 仍在 ----
(check-equal? (E/models '() "(shell-quote \"it's\")") "'it'\\''s'")
(check-equal? (E/models '() "(string-trim \"  x  \")") "x")

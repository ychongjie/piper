#lang racket/base

;; M2 测试:LLM 接入。用可注入的 mock backend,不打真网络。
;; (真实 llm CLI 的端到端验证见 examples/ai.piper,手动跑。)
;; 运行:raco test tests/m2-test.rkt

(require rackunit "../src/interp.rkt" "../src/llm.rkt")

;; 在给定 mock 响应下,新建解释器并求值 Piper 源码
(define (E/mock response src)
  (parameterize ([current-llm (lambda (prompt system model) response)])
    (eval-string src (make-interpreter))))

;; 可按 prompt 返回不同响应的 mock
(define (E/dispatch table src)
  (parameterize ([current-llm (lambda (prompt system model)
                                (cond [(assoc prompt table) => cdr]
                                      [else (error "unexpected prompt" prompt)]))])
    (eval-string src (make-interpreter))))

;; ---- ask / llm:原始文本 ----
(check-equal? (E/mock "hello there" "(ask \"hi\")") "hello there")
(check-equal? (E/mock "raw output"  "(llm \"x\")") "raw output")

;; ---- llm-code:文本 → s-expr ----
(check-equal? (E/mock "(+ 1 2)" "(llm-code \"...\")") '(+ 1 2))
(check-equal? (E/mock "(lambda (x) (* x x))" "(llm-code \"...\")")
              '(lambda (x) (* x x)))

;; ---- eval:生成即运行 ----
(check-equal? (E/mock "(+ 1 2)" "(eval (llm-code \"算 1+2\"))") 3)
(check-equal? (E/mock "(* 6 7)" "(gen \"算 6*7\")") 42)

;; ---- 去 markdown 围栏 ----
(check-equal? (E/mock "```scheme\n(* 2 3)\n```" "(gen \"...\")") 6)
(check-equal? (E/mock "```\n(+ 10 20)\n```"     "(gen \"...\")") 30)
(check-equal? (strip-fences "```lisp\n(foo)\n```") "(foo)")
(check-equal? (strip-fences "  (bar)  ") "(bar)")

;; ---- 生成定义后即可调用(同像性的闭环) ----
(check-equal?
 (E/mock "(define (sq x) (* x x))"
         "(begin (eval (llm-code \"定义平方\")) (sq 9))")
 81)

;; ---- LLM 产出的代码用到 prelude,且能再生成(自举味道) ----
(check-equal?
 (E/mock "(map (lambda (x) (* x x)) (range 5))"
         "(gen \"前5个平方\")")
 '(0 1 4 9 16))

;; ---- backend 报错应向上抛 ----
(check-exn exn:fail?
 (lambda ()
   (parameterize ([current-llm (lambda (p s m) (error "boom"))])
     (eval-string "(ask \"x\")" (make-interpreter)))))

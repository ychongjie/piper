#lang racket/base

;; LLM 接入(docs/DESIGN.md §7):把 simonw/llm 当作无状态补全子进程。
;; 设计要点:
;;  - backend 可注入(current-llm 参数),测试用 mock,不打真网络;
;;  - spawn 子进程时为子进程剥掉 proxy 变量(httpx 走 SOCKS 需 socksio,
;;    直连即可),用户照常 `racket main.rkt prog.piper` 无需手动 env -u;
;;  - llm-code:文本 → 去 markdown 围栏 → read 成一棵可 eval 的 s-expr(同像性兑现)。

(require racket/port racket/string)

(provide current-model current-max-tokens current-llm current-strip-proxy code-system
         current-llm-verbose
         llm-call llm-code-call strip-fences)

(define current-model (make-parameter "deepseek-v4-pro"))

;; 单次补全的 max_tokens 上限(防止较长的代码生成被截断成不完整 s-expr)
(define current-max-tokens (make-parameter 4096))

;; 是否把每次真实 LLM 调用的输入/输出/耗时打到 stderr(便于观察 agent 进展)
(define current-llm-verbose (make-parameter #t))

(define (log-llm model system prompt result ms)
  (eprintf "\n========== LLM (~a) · ~a ms ==========\n"
           model (inexact->exact (round ms)))
  (when (and system (> (string-length system) 0))
    (eprintf "[system] ~a\n" system))
  (eprintf "[input]\n~a\n[output]\n~a\n=====================================\n"
           prompt result))

;; spawn llm 时为子进程移除这些环境变量(规避 SOCKS 代理导致的 httpx 报错)
(define current-strip-proxy
  (make-parameter '("all_proxy" "http_proxy" "https_proxy"
                    "ALL_PROXY" "HTTP_PROXY" "HTTPS_PROXY")))

;; 约束模型只吐一个合法 s-expr
(define code-system
  (string-append
   "You output ONLY a single Scheme/Lisp s-expression. "
   "No prose, no explanation, no markdown code fences."))

;; 可注入的 backend:(prompt system model) -> string
(define current-llm (make-parameter (lambda (p s m) (real-llm p s m))))

;; ---- 真实 backend:shell out 到 llm CLI ----

(define (child-env-without-proxy)
  (define src (current-environment-variables))
  (define strip (map string->bytes/utf-8 (current-strip-proxy)))
  (define kept
    (apply append
           (for/list ([n (in-list (environment-variables-names src))]
                      #:unless (member n strip))
             (list n (environment-variables-ref src n)))))
  (apply make-environment-variables kept))

(define (real-llm prompt system model)
  (define exe (or (find-executable-path "llm")
                  (error 'llm "llm CLI not found on PATH")))
  (define args
    (append (list "-m" model "-o" "max_tokens" (number->string (current-max-tokens)))
            (if (and system (> (string-length system) 0)) (list "-s" system) '())
            (list prompt)))
  (parameterize ([current-environment-variables (child-env-without-proxy)])
    (define start (current-inexact-milliseconds))
    (define-values (sp out in err) (apply subprocess #f #f #f exe args))
    (close-output-port in)
    (define result (port->string out))
    (define errtext (port->string err))
    (subprocess-wait sp)
    (close-input-port out)
    (close-input-port err)
    (define elapsed (- (current-inexact-milliseconds) start))
    (unless (eqv? (subprocess-status sp) 0)
      (error 'llm "llm CLI failed (status ~a): ~a"
             (subprocess-status sp) (string-trim errtext)))
    (when (current-llm-verbose) (log-llm model system prompt result elapsed))
    result))

;; ---- Piper 面向的入口 ----

(define (llm-call prompt [system ""] [model (current-model)])
  ((current-llm) prompt system model))

;; 去掉 ```lang ... ``` markdown 围栏(模型偶尔会加)
(define (strip-fences s)
  (define t (string-trim s))
  (define m (regexp-match #px"(?s:```[a-zA-Z0-9]*\\s*(.*?)\\s*```)" t))
  (if m (string-trim (cadr m)) t))

;; LLM → s-expr:返回一棵可 eval 的树
(define (llm-code-call prompt [model (current-model)])
  (read (open-input-string (strip-fences ((current-llm) prompt code-system model)))))

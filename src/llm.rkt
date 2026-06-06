#lang racket/base

;; LLM 接入(docs/DESIGN.md §7):把 simonw/llm 当作无状态补全子进程。
;; 设计要点:
;;  - backend 可注入(current-llm 参数),测试用 mock,不打真网络;
;;  - spawn 子进程时为子进程剥掉 proxy 变量(httpx 走 SOCKS 需 socksio,
;;    直连即可),用户照常 `racket main.rkt prog.piper` 无需手动 env -u;
;;  - llm-code:文本 → 去 markdown 围栏 → read 成一棵可 eval 的 s-expr(同像性兑现)。

(require racket/port racket/string)

(provide current-model current-llm current-strip-proxy code-system
         llm-call llm-code-call strip-fences)

(define current-model (make-parameter "deepseek-v4-pro"))

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
    (append (list "-m" model)
            (if (and system (> (string-length system) 0)) (list "-s" system) '())
            (list prompt)))
  (parameterize ([current-environment-variables (child-env-without-proxy)])
    (define-values (sp out in err) (apply subprocess #f #f #f exe args))
    (close-output-port in)
    (define result (port->string out))
    (define errtext (port->string err))
    (subprocess-wait sp)
    (close-input-port out)
    (close-input-port err)
    (unless (eqv? (subprocess-status sp) 0)
      (error 'llm "llm CLI failed (status ~a): ~a"
             (subprocess-status sp) (string-trim errtext)))
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

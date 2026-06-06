#lang racket/base

;; 解释器装配:Reader(复用宿主 read)+ 全局环境 + prelude 加载。
;; docs/DESIGN.md §4「Reader」:MVP 直接复用 Racket 的 read,
;; LLM 产出的字符串经 read 即得可 eval 的 s-expr。

(require racket/runtime-path
         "env.rkt" "eval.rkt" "primitives.rkt")

(provide make-interpreter
         eval-all eval-string eval-file
         (all-from-out "eval.rkt")
         (all-from-out "env.rkt"))

(define-runtime-path prelude-path "../lib/prelude.piper")

;; 依次 read 并求值 port 中的所有顶层表达式,返回最后一个值
(define (eval-all port env)
  (let loop ([last (void)])
    (define form (read port))
    (if (eof-object? form) last (loop (peval form env)))))

(define (eval-string s env)
  (eval-all (open-input-string s) env))

(define (eval-file path env)
  (call-with-input-file path (lambda (p) (eval-all p env))))

;; 建一个加载好 prelude 的全局环境
(define (make-interpreter)
  (define g (make-global-env))
  (eval-file prelude-path g)
  g)

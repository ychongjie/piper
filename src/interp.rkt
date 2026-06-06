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

(define-runtime-path lib-dir "../lib")

;; 标准库按顺序加载(后者可依赖前者)
(define lib-files
  '("prelude.piper" "amb.piper" "agent.piper" "loop.piper"
    "self-modify.piper" "grow.piper" "orchestrate.piper"))

;; 先把所有顶层 form 读进列表,再依次求值,返回最后一个值。
;; 关键:读到列表后,回溯(amb)跳回前面的 form 时,续延持有的是不可变的
;; 列表尾(cdr fs),约束会被重新求值;若从可变 port 逐个读则会"读过头"。
(define (read-all port)
  (let loop ([acc '()])
    (define f (read port))
    (if (eof-object? f) (reverse acc) (loop (cons f acc)))))

(define (eval-all port env)
  (let loop ([fs (read-all port)] [last (void)])
    (if (null? fs) last (loop (cdr fs) (peval (car fs) env)))))

(define (eval-string s env)
  (eval-all (open-input-string s) env))

(define (eval-file path env)
  (call-with-input-file path (lambda (p) (eval-all p env))))

;; 建一个加载好标准库的全局环境
(define (make-interpreter)
  (define g (make-global-env))
  (for ([f (in-list lib-files)])
    (eval-file (build-path lib-dir f) g))
  g)

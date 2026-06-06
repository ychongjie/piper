#lang racket/base

;; 元循环求值器:eval / apply + M0 特殊形式。
;; 直接风格,跑在宿主 Racket 栈上(docs/DESIGN.md §5)。
;;
;; M0 范围:纯 Scheme 子集——
;;   quote if define set! lambda begin let cond and or + 函数应用。
;; 控制流唯一特权特殊形式(call/cc)留到 M1;LLM/amb/goal/loop 留到后续里程碑。

(require "env.rkt")

(provide (struct-out closure)
         (struct-out primitive)
         peval papply
         truthy?)

;; 闭包:形参表 + body(表达式序列,隐式 begin)+ 捕获的定义环境
(struct closure (params body env) #:transparent)
;; 原语:名字 + 宿主 Racket 过程
(struct primitive (name proc) #:transparent)

(define (self-eval? x)
  (or (number? x) (string? x) (boolean? x) (char? x)))

;; Scheme 真值:除 #f 外皆真
(define (truthy? x) (not (eq? x #f)))

;; ---- eval --------------------------------------------------------------

(define (peval exp env)
  (cond
    [(self-eval? exp) exp]
    [(symbol? exp)    (env-lookup env exp)]
    [(pair? exp)
     (case (car exp)
       [(quote)  (cadr exp)]
       [(if)     (eval-if exp env)]
       [(define) (eval-define exp env)]
       [(set!)   (eval-set! exp env)]
       [(lambda) (closure (cadr exp) (cddr exp) env)]
       [(begin)  (eval-seq (cdr exp) env)]
       [(let)    (eval-let exp env)]
       [(cond)   (eval-cond (cdr exp) env)]
       [(and)    (eval-and (cdr exp) env)]
       [(or)     (eval-or  (cdr exp) env)]
       [else     (eval-app exp env)])]
    [(null? exp) (error 'piper "cannot evaluate empty combination ()")]
    [else (error 'piper "cannot evaluate: ~s" exp)]))

;; ---- 特殊形式 ----------------------------------------------------------

(define (eval-if exp env)
  (if (truthy? (peval (cadr exp) env))
      (peval (caddr exp) env)
      (if (>= (length exp) 4) (peval (cadddr exp) env) (void))))

;; (define x v) | (define (f a b ...) body...) | (define (f . rest) body...)
(define (eval-define exp env)
  (define target (cadr exp))
  (cond
    [(pair? target)
     (define name (car target))
     (env-define! env name (closure (cdr target) (cddr exp) env))
     name]
    [else
     (env-define! env target (peval (caddr exp) env))
     target]))

(define (eval-set! exp env)
  (env-set! env (cadr exp) (peval (caddr exp) env))
  (void))

;; 顺序求值,返回最后一个值
(define (eval-seq exps env)
  (cond
    [(null? exps) (void)]
    [(null? (cdr exps)) (peval (car exps) env)]
    [else (peval (car exps) env) (eval-seq (cdr exps) env)]))

;; (let ((x e) ...) body...)  —— 各初值在外层环境求值,再绑成新 frame
(define (eval-let exp env)
  (define bindings (cadr exp))
  (define inner (make-env env))
  (for-each
   (lambda (b) (env-define! inner (car b) (peval (cadr b) env)))
   bindings)
  (eval-seq (cddr exp) inner))

(define (eval-cond clauses env)
  (cond
    [(null? clauses) (void)]
    [(eq? (caar clauses) 'else) (eval-seq (cdar clauses) env)]
    [(truthy? (peval (caar clauses) env)) (eval-seq (cdar clauses) env)]
    [else (eval-cond (cdr clauses) env)]))

(define (eval-and exps env)
  (cond
    [(null? exps) #t]
    [(null? (cdr exps)) (peval (car exps) env)]
    [(truthy? (peval (car exps) env)) (eval-and (cdr exps) env)]
    [else #f]))

(define (eval-or exps env)
  (cond
    [(null? exps) #f]
    [else (define v (peval (car exps) env))
          (if (truthy? v) v (eval-or (cdr exps) env))]))

;; ---- 函数应用 ----------------------------------------------------------

(define (eval-app exp env)
  (define proc (peval (car exp) env))
  (define args (map (lambda (a) (peval a env)) (cdr exp)))
  (papply proc args))

(define (papply proc args)
  (cond
    [(primitive? proc) (apply (primitive-proc proc) args)]
    [(closure? proc)
     (eval-seq (closure-body proc)
               (extend-env (closure-params proc) args (closure-env proc)))]
    [else (error 'piper "not applicable: ~s" proc)]))

#lang racket/base

;; 环境:frame 链表,每个 frame 是一个可变 hash。
;; 全局 frame 单独持有(见 interp.rkt),便于将来自修改与快照。
;; 设计依据见 docs/DESIGN.md §5.2「环境模型(环境是数据)」。

(provide (struct-out env)
         make-env
         env-lookup
         env-define!
         env-set!
         extend-env)

(struct env (vars parent) #:mutable #:transparent)

;; 新建一个 frame,parent 为父环境(#f 表示全局根)
(define (make-env [parent #f])
  (env (make-hasheq) parent))

;; 沿链查找;找不到报未绑定错误
(define (env-lookup e sym)
  (cond
    [(not e) (error 'piper "unbound variable: ~a" sym)]
    [(hash-has-key? (env-vars e) sym) (hash-ref (env-vars e) sym)]
    [else (env-lookup (env-parent e) sym)]))

;; 在当前 frame 绑定(define 语义)
(define (env-define! e sym val)
  (hash-set! (env-vars e) sym val))

;; 沿链改写已存在的绑定(set! 语义)
(define (env-set! e sym val)
  (cond
    [(not e) (error 'piper "set! on unbound variable: ~a" sym)]
    [(hash-has-key? (env-vars e) sym) (hash-set! (env-vars e) sym val)]
    [else (env-set! (env-parent e) sym val)]))

;; 用形参表把实参绑成一个新 frame。
;; 支持三种形参表:
;;   (a b c)      固定参数
;;   (a b . rest) 点对:rest 收集多余实参
;;   args         单符号:收集全部实参
(define (extend-env params args parent)
  (define e (make-env parent))
  (bind-params! e params args)
  e)

(define (bind-params! e params args)
  (cond
    [(symbol? params) (env-define! e params args)]   ; (lambda args ...)
    [(null? params)
     (unless (null? args) (error 'piper "too many arguments"))]
    [(pair? params)
     (when (null? args) (error 'piper "too few arguments"))
     (env-define! e (car params) (car args))
     (bind-params! e (cdr params) (cdr args))]
    [else (error 'piper "bad parameter list: ~s" params)]))

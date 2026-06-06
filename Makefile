RACKET ?= racket
RACO   ?= raco

.PHONY: test repl run example

test:
	$(RACO) test tests/

repl:
	$(RACKET) main.rkt

# 运行一个 Piper 程序:make run FILE=examples/hello.piper
run:
	$(RACKET) main.rkt $(FILE)

example:
	$(RACKET) main.rkt examples/hello.piper

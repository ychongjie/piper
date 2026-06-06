# 故意写错的几个函数,交给竞争式 agent 修(见 examples/fix-compete.piper)。
# 修复目标:让 check.py 输出的通过数最大。不要改 check.py。

def add(a, b):
    return a - b            # BUG: 应该是加

def is_even(n):
    return n % 2 == 1       # BUG: 这是判断奇数

def reverse_str(s):
    return s                # BUG: 没有反转

def factorial(n):
    r = 1
    for i in range(1, n):   # BUG: 应该到 n+1
        r *= i
    return r

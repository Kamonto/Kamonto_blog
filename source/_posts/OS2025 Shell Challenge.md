---
title: OS2025 Shell Challenge
date: 2025-07-02 02:19:23
tags:
---

# OS Shell 挑战性任务实验报告

## 任务要求

在 lab6 中，我们在 MOS 中实现了简单的 Shell ，但是距离真正的 Shell 还有很大一段距离。在本次挑战性任务中，我们需要基于 lab 6 的实现，完善我们的 Shell 的下列功能，通过自动评测并撰写实验报告：

1. 支持相对路径
2. 加入内建指令 `cd` `pwd` 
3. 支持局部变量与全局变量
4. 加入内建指令 `declare` `unset` 
5. 支持在输入指令时使用 `left-arrow` 和 `right-arrow` 移动光标
6. 支持在输入指令时在任意位置插入和删除字符
7. 支持兼容不以 `.b` 结尾的外部指令
8. 支持 `ctrl-E` `ctrl-A` `ctrl-K` `ctrl-U` `ctrl-W` 等快捷键
9. 支持使用 `up-arrow` 和 `down-arrow` 回溯历史指令
10. 加入内建指令 `history` 
11. 支持使用 `#` 进行注释
12. 支持反引号 `` ` `` 
13. 支持使用分号 `;` 实现一行多指令
14. 支持使用 `&&` 和 `||` 实现指令条件执行
15. 加入外部指令 `mkdir` `touch` `rm` 和内建指令 `exit` 
16. 支持使用 `>>` 实现追加重定向

## 写在前面的话

本篇实验报告与源代码在部分内容上有所出入，是因为在我完成整个实验，重新复盘整个实现过程时，发现早期写的有些内容虽能通过自动评测，但可能并不严谨，或者写法较为麻烦，或者有重复造轮子的现象，在写实验报告时均加以改正。由于写本篇实验报告时，自动评测已经截止，所以不能确定改正部分完全正确，**如实验报告中内容出现错误，以源代码为准**。

本篇实验报告的“实现细节”部分按照课程组提供的任务清单的顺序撰写，但会出现前文任务依赖后文实现的错乱情况，在真正进行挑战性任务的时候并非完全按照文中顺序完成。我个人倾向于首先完成指令自由修改和指令格式兼容，接下来完成相对路径和三个外部指令，以及追加重定向，最后再完成剩下的内容。

## 实现细节

### 支持相对路径

首先我们需要考虑如何存取当前路径，即当前的工作目录。这里我选择将当前路径以字符串的形式存储在 `struct Env` 结构体中，也就是每个进程都有自己的当前路径：

```c
// include/env.h
struct Env {
    ...
    // Shell: relative path and environment variables
    char relative_path[256];
    ...
};
```

注意到，此时的当前路径是存储在内核中的，在用户态下我们不能直接获取其内容，需要通过 syscall 进行存取。于是我们设计两种系统调用 `syscall_get_relative_path` 和 `syscall_set_relative_path` 。在 lab 4 我们已经熟练掌握了添加新系统调用的方法，所以我们故技重施：

```c
// user/include/lib.h
int syscall_get_relative_path(char *res);
int syscall_set_relative_path(char *src);

// user/lib/syscall_lib.c
int syscall_get_relative_path(char *res) {
    return msyscall(SYS_get_relative_path, res);
}

int syscall_set_relative_path(char *src) {
    return msyscall(SYS_set_relative_path, src);
}

// include/syscall.h
enum {
    ...
    SYS_get_relative_path,
    SYS_set_relative_path,
    ...
    MAX_SYSNO,
};

// kern/syscall_all.c
void *syscall_table[MAX_SYSNO] = {
    ...
    [SYS_get_relative_path] = sys_get_relative_path,
    [SYS_set_relative_path] = sys_set_relative_path,
    ...
};

// kern/syscall_all.c
int sys_get_relative_path(char *res) {
    if (res == NULL) {
    return -E_INVAL;
    }
    strcpy(res, curenv->relative_path);
    return 0;
}

int sys_set_relative_path(char *src) {
    if (src == NULL) {
    return -E_INVAL;
    }
    strcpy(curenv->relative_path, src);
    return 0;
}
```

这样，我们在用户态通过调用 `syscall_get_relative_path()` 和 `syscall_set_relative_path()` 两个函数就可以实现对当前路径的存取了。

在 Shell 中，我们经常需要 fork 子进程来执行任务，为了让子进程也能读取到当前路径，我们在 fork 的同时将当前路径传递给子进程：

```c
// kern/syscall_all.c
int sys_exofork(void) {
    ...
    strcpy(e->relative_path, curenv->relative_path);
    ...
}
```

现在我们已经能够自由存取当前路径了，接下来就是使用它了。在所有出现使用相对路径的场景，我们都需要将相对路径与当前路径进行拼接，组合成绝对路径使用。为此，我们需要创建一个将相对路径转换成绝对路径的函数 `rel2abs()` ：

```c
// user/include/lib.h
void rel2abs(const char *src, char *res);

// user/lib/file.c
void rel2abs(const char *src, char *res) {
    char relpath[1024];

    // 如果首位是 '/' 则为绝对路径，否则为相对路径
    if (src[0] == '/') {
        strcpy(relpath, src);
    }
    else {
        syscall_get_relative_path(relpath);
        int temprellen = strlen(relpath);
        // 进行拼接时，如果当前路径不以 '/' 结尾，则添加 '/' 后再拼接
        if (relpath[temprellen] != '/') {
            relpath[temprellen++] = '/';
        }
        strcpy(relpath + temprellen, src);
    }

    int rellen = strlen(relpath);
    int stack[1024];
    int stacktop = 0;
    int begin = 1;
    int allres = 0;

    // 分割路径，处理 . 和 .. 
    // stack 数组记录处理后每层路径的起始下标
    for (int i = 1; i <= rellen; i++) {
        // 每次读到 '/' 或字符串结束时记录下标
        if (i == rellen || relpath[i] == '/') {
            int len = i - begin;
            // 如果本段字符串是 . 则不记录下标
            if (len == 1 && relpath[begin] == '.') {
                // do nothing
            }
            // 如果本段字符串是 .. 若下标个数不为 0 则弹出上一个下标
            else if (len == 2 && relpath[begin] == '.' && relpath[begin] == '.') {
                if (stacktop > 0) {
                    stacktop--;
                }
            }
            // 否则记录本段字符串的起始位置
            else if (len > 0) {
                stack[stacktop++] = begin;
            }
            begin = i + 1;
        }
    }

    // 若栈为空则为根目录，单走一个 '/'
    if (stacktop == 0) {
        res[allres++] = '/';
    }

    // 否则将每个下标对应的字符串写入 res 中
    for (int i = 0; i < stacktop; i++) {
        res[allres++] = '/';
        for (int j = stack[i]; j < rellen && relpath[j] != '/'; j++) {
            res[allres++] = relpath[j];
        }
    }

    res[allres] = '\0';
}

```

这样我们就实现了相对路径到绝对路径的转换，只要在用户态下调用该函数即可。目前只有 `user/lib/file.c` 中的 `open()` 函数会使用路径识别文件（其它所有函数都是使用 `open()` 函数返回的文件标识符识别文件），所以我们在 `open()` 函数中将 `path` 送进 `rel2path()` 函数中转换一下即可。

### 加入内建指令 `cd` `pwd` 

这里要强调的是，在我们将当前路径存储在 `struct Env` 中的前提下，`cd` 就必须是内建指令，可以参考指导书 Thinking 6.7 给出原因。对于读当前路径的操作，只要保证在 fork 出子进程之后，父进程的当前路径不会改变，我们就可以在子进程中读出父进程的当前路径；然而我们万万不可在子进程中写当前路径，这样是不能自动传回父进程的。

内建指令的要求是不能创建任何子进程，必须在主 Shell 进程中执行指令。正常情况下，我们在主函数中进入 `runcmd()` 函数之前就会 fork 一次，在进入 `runcmd()` 函数之后还会 spawn 一次，这就创建了两个子进程。在内建指令中，我们要取消掉这两次创建子进程，首先我们需要一个判断当前指令是不是内建指令的函数 `is_built_in_command()` ：

```c
// user/sh.c
int is_built_in_command(char *buffer) {
    char cmd[10];
    int buflen = strlen(buffer);
    int i;
    // 取出 buffer 中的第一个单词
    for (i = 0; i < buflen && buffer[i] != ' '; i++) {
        cmd[i] = buffer[i];
    }
    cmd[i] = '\0';
    // 进行字符串比对
    if (!strcmp(cmd, "cd")) {
        return 1;
    }
    else if (...) {
        return 1;
    }
    else {
        return 0;
    }
}
```

在主函数中，我们判断如果是内建指令，就跳过 fork 的环节：

```c
// user/sh.c
int main(int argc, char **argv) {
    ...
    for (;;) {
        ...
        if (!is_built_in_command(buf)) {
            if ((r = fork()) < 0) {
                user_panic("fork: %d", r);
            }
            if (r == 0) {
                runcmd(buf);
                exit();
            } else {
                wait(r);
            }
        }
        else {
            runcmd(buf);
        }
    }
    return 0;
}
```

在 `runcmd()` 函数中，我们判断如果是内建指令，就直接执行后返回，不需要再执行 spawn 及以后的内容：

```c
// user/sh.c
void runcmd(char *s) {
    ...
    if (!strcmp(argv[0], "cd")) {
        cd(argc, argv);
        return;
    }
    else if (...) {
        ...(argc, argv);
        return;
    }

    int child = spawn(argv[0], argv);
    ...
}
```

在此之后我们遇到的所有内建指令都需要经过这个流程，在上述代码中的 `else if` 处继续填写即可，以后不再赘述。

下面我们就要正式实现上述代码中 `cd()` 函数的内容了。作为内建指令，`cd` 指令不是一个存储在 Shell 根目录的 `.b` 类型的可执行文件，需要 spawn 出来的子进程才能执行，它真的只是一个函数而已：

```c
// user/sh.c
int cd(int argc, char **argv) {
    // 如果没有指定路径，返回至根目录
    if (argc == 1) {
        syscall_set_relative_path("/");
        return 0;
    }
    else if (argc == 2) {
        char abspath[1024];
        // 将相对路径转换为绝对路径
        rel2abs(argv[1], abspath);
        // 获取文件描述符
        int fd = open(abspath, O_RDONLY);
        struct Stat st;
        // 如果文件不存在
        if (fd < 0) {
        printf("cd: The directory '%s' does not exist\n", argv[1]);
            return 1;
        }
        // 有 open 一定要有 close ，否则会报错
        close(fd);
        // 获取文件状态（是否是目录）
        stat(abspath, &st);
        if (!st.st_isdir) {
            printf("cd: '%s' is not a directory\n", argv[1]);
        return 1;
        }
        syscall_set_relative_path(abspath);
        return 0;
    }
    else {
        printf("Too many args for cd command\n");
        return 1;
    }
}
```

`pwd` 指令就更加简单了，如果把它写成内建指令的话，仿照 `cd` 指令，只需要在 `pwd()` 函数内调用一下 `syscall_get_relative_path()` 函数，再加上一些简单的异常处理即可。但是我为什么要说如果呢？因为我处于某些原因，把它写成了外部指令，这个原因后续会提到。下面就以 `pwd` 指令为例介绍一下把一个本该是内建指令写成外部指令的流程：

我们首先要做的是评判其可行性，比如我们刚才提到 `cd` 指令在我们的实现下就是不能写成外部指令的，但是我们刚才也说过，“只要保证在 fork 出子进程之后，父进程的当前路径不会改变，我们就可以在子进程中读出父进程的当前路径”，我们的 Shell 正是如此。因为我们刚才提到的一次 fork 和一次 spawn 操作都是在我们输入完当前指令后才会执行，在读出当前路径之前确实不会有机会修改当前路径，而且两个子进程在执行完指令之后也会被销毁掉，可以说把“犯罪现场”清理得干干净净，真是一场天衣无缝的“完美犯罪”~

接下来就是动手开干了！这次我们不仿照内建指令，而是仿照其它已经实现的外部指令，在 `user` 中创建一个新文件 `pwd.c` ，将实现内容写在其主函数中：

```c
// user/pwd.c
#include <lib.h>

int main(int argc, char **argv) {
    if (argc != 1) {
        printf("pwd: expected 0 arguments; got %d\n", argc - 1);
            return 2;
    }
    else {
        char relpath[1024];
        syscall_get_relative_path(relpath);
        // 如果当前路径为空，说明在根目录，手动添加一个 '/'
        if (!strcmp(relpath, "")) {
            relpath[0] = '/';
            relpath[1] = '\0';
        }
        printf("%s\n", relpath);
        return 0;
    }
}
```

接下来我们将其对应的 `.b` 文件（编译时会自动生成）加入到 Makefile 中。这里一定要注意的是，我们的规则不允许我们更改除了 `new.mk` 以外的所有 Makefile 文件，否则就会出现本地测试全部正常，然而交上去之后无论如何都无法通过的抓狂现象。

```makefile
# user/new.mk
INITAPPS +=

USERLIB +=

USERAPPS += pwd.b
```

还有最后一个问题，如果细心观察就可以发现，内建指令和外部指令在 Shell 中的调用方法是不同的。外部指令是一个 `.b` 文件，需要输入完整的文件路径来调用，前有 `/` ，后有 `.b`（如果当前处于根目录下，则根据相对路径可以省略 `/` ，否则会因为位置不正确而找不到指令文件）；而内部指令是一个函数，只需要输入指令名即可调用。所以在这里我们看似输入了 `pwd` ，但我们的 Shell 实际上应该将其偷偷解析成 `/pwd.b` 才能正常使用，这里的做法将会放到“支持兼容不以 `.b` 结尾的外部指令”一节去介绍。

### 支持局部变量与全局变量

这一部分的内容和当前路径的存储非常相似，依旧是把变量存储于 `struct Env` 中，并通过 syscall 进行存取，只不过工作量更加巨大。首先我们在 `struct Env` 中添加变量结构体 `struct Envvar` 的数组，并记录下它们的总数：

```c
// include/env.h
// Environment variables
struct Envvar {
    char key[16];
    char value[16];
    int is_global;    // 是否是全局变量
    int is_read_only; // 是否是只读变量
};

struct Env {
    // Shell: relative path and environment variables
    ...
    struct Envvar envvars[16];
    int allenvvar;
};
```

这里需要注意 `envvars` 结构体的数量不能太多，否则会导致启动 Shell 时直接崩溃。

下一步就是设计一些系统调用了。由于变量相关的操作比较多，这次我们设计 4 个系统调用：用于获取一个 key 的 value 的 `syscall_get_envvar` ，用于获取全部键值对的 `syscall_get_all_envvar` ，用于写入一个键值对的 `syscall_put_envvar` ，以及用于删除一个键值对的 `syscall_del_envvar` ：

```c
// user/include/lib.h
int syscall_get_envvar(char *src, char *res);
int syscall_get_all_envvar(char (*res)[32]);
int syscall_put_envvar(char *key, char *value, int is_global, int is_read_only);
int syscall_del_envvar(char *src);

// user/lib/syscall_lib.c
int syscall_get_envvar(char *src, char *res) {
    return msyscall(SYS_get_envvar, src, res);
}

int syscall_get_all_envvar(char (*res)[32]) {
    return msyscall(SYS_get_all_envvar, res);
}

int syscall_put_envvar(char *key, char *value, int is_global, int is_read_only) {
    return msyscall(SYS_put_envvar, key, value, is_global, is_read_only);
}

int syscall_del_envvar(char *src) {
    return msyscall(SYS_del_envvar, src);
}

// include/syscall.h
enum {
    ...
    SYS_get_envvar,
    SYS_get_all_envvar,
    SYS_put_envvar,
    SYS_del_envvar
    MAX_SYSNO,
};

// kern/syscall_all.c
void *syscall_table[MAX_SYSNO] = {
    ...
    [SYS_get_envvar] = sys_get_envvar,
    [SYS_get_all_envvar] = sys_get_all_envvar,
    [SYS_put_envvar] = sys_put_envvar,
    [SYS_del_envvar] = sys_del_envvar,
};

// kern/syscall_all.c
// 输入 src 为 key ，输出 res 为 value
int sys_get_envvar(char *src, char *res) {
    if (src == NULL || res == NULL) {
        return -E_INVAL;
    }
    for (int i = 0; i < curenv->allenvvar; i++) {
        if (!strcmp(curenv->envvars[i].key, src)) {
            strcpy(res, curenv->envvars[i].value);
            return 0;
        }
    }
    return -E_NOT_FOUND;
}

// 输出 res 为全部键值对，格式为 <key>=<value> ，返回值为键值对总数
// 注意 res 的类型不能设置为 char ** ，否则会报错
int sys_get_all_envvar(char (*res)[32]) {
    for (int i = 0; i < curenv->allenvvar; i++) {
        strcpy(res[i], curenv->envvars[i].key);
        int len = strlen(res[i]);
        res[i][len++] = '=';
        strcpy(res[i] + len, curenv->envvars[i].value);
    }
    return curenv->allenvvar;
}

// 4 个参数全部为输入参数
int sys_put_envvar(char *key, char *value, int is_global, int is_read_only) {
    int allvar = curenv->allenvvar;
    for (int i = 0; i < curenv->allenvvar; i++) {
        // 如果该变量已经存在
        if (!strcmp(curenv->envvars[i].key, key)) {
            // 只读变量不可以被修改
            if (curenv->envvars[i].is_read_only == 0) {
                strcpy(curenv->envvars[i].value, value);
                return 0;
            }
            else {
                return -E_NOT_FOUND;
            }
        }
    }
    // 如果该变量不存在
    strcpy(curenv->envvars[allvar].key, key);
    strcpy(curenv->envvars[allvar].value, value);
    curenv->envvars[allvar].is_global = is_global;
    curenv->envvars[allvar].is_read_only = is_read_only;
    curenv->allenvvar++;
    return 0;
}

// 输入 src 为 key
int sys_del_envvar(char *src) {
    for (int i = 0; i < curenv->allenvvar; i++) {
        // 如果该变量存在
        if (!strcmp(curenv->envvars[i].key, src)) {
            // 只读变量不可以被删除
            if (curenv->envvars[i].is_read_only == 0) {
                for (int j = i + 1; j < curenv->allenvvar; j++) {
                    curenv->envvars[j - 1] = curenv->envvars[j];
                }
                curenv->allenvvar--;
                return 0;
            }
            else {
                return -E_NOT_FOUND;
            }
        }
    }
    return -E_NOT_FOUND;
}
```

加入了上述定义之后，我们就可以在用户态使用 `syscall_..._envvar()` 访问这些函数了，当然这是下一节的事情了。现在我们还是来讨论一下父子进程之间变量的传递，以及如何替换指令中的变量。

还是和当前路径相同，我们在 fork 的同时向子进程传递变量，但需要注意只有全局变量会被传递，局部变量不能被传递（这就要求了 `declare` 和 `unset` 函数必须都是内建指令）：

```c
// kern/syscall_all.c
int sys_exofork(void) {
    ...
    // 这里注意 allenvvar 也会发生变化，所以不能直接传值，而是每加入一个 envvar ，allenvvar++
    e->allenvvar = 0;
    for (int i = 0; i < curenv->allenvvar; i++) {
        if (curenv->envvars[i].is_global) {
            e->envvars[e->allenvvar++] = curenv->envvars[i];
        }
    }

    return e->env_id;
}
```

在替换环境变量时，我们以 `$` 作为识别开始的标志，以从 `$` 开始的第一个非字母、非数字、非下划线的字符（实际上样例中只会出现空格和 `/` 两种结束符，特判一下即可），以及字符串结束作为识别结束的标志，截取这一段字符串作为 key ，使用 syscall 读出 value 后替换即可：

```c
// user/sh.c
void replace_envvar(char *buffer) {
    char res[1024];
    int allres = 0;
    int buflen = strlen(buffer);
    for (int i = 0; i < buflen; i++) {
        if (buffer[i] == '$') {
            char key[16] = {'\0'};
            char value[16] = {'\0'};
            for (int j = i + 1; j < buflen && buffer[j] != ' ' && buffer[j] != '/'; j++) {
                key[j - i - 1] = buffer[j];
            }
            syscall_get_envvar(key, value);
            strcpy(res + allres, value);
            i += strlen(key);
            allres += strlen(value);
        }
        else {
            res[allres++] = buffer[i];
        }
    }
    res[allres] = '\0';
    strcpy(buffer, res);
}

int main(int argc, char **argv) {
    ...
    for (;;) {
        ...
        replace_envvar(buf);

        if (!is_built_in_command(buf)) {
            ...
        }
        else {
            runcmd(buf);
        }
    }
    return 0;
}
```

### 加入内建指令 `declare` `unset` 

在上一节我们已经分析了这两个指令必须是内建指令，所以我们仿照 `cd` 指令，在 `user/sh.c` 中的 `is_built_in_command()` 函数和 `runcmd()` 函数中分别加入两个指令相关的分支判断，再在 `user/sh.c` 中编写两个指令对应的函数即可：

```c
// user/sh.c
int declare(int argc, char **argv) {
    int is_global = 0;
    int is_read_only = 0;
    char kvset[32] = {'\0'};
    char key[16] = {'\0'};
    char value[16] = {'\0'};
    
    // declare 后面没有参数，此时输出全部键值对内容
    if (argc == 1) {
        char envvars[16][32] = {'\0'};
        int allvar = syscall_get_all_envvar(envvars);
        for (int i = 0; i < allvar; i++) {
            printf("%s\n", envvars[i]);
        }
        return 0;
    }
    // 这里只取出键值对到 kvset 中，后续再进行处理
    // declare 后面只有一个参数，说明没有 -x, -f, -xf
    else if (argc == 2) {
        strcpy(kvset, argv[1]);
    }
    // declare 后面有两个参数，说明有 -x, -f, -xf
    else if (argc == 3) {
        strcpy(kvset, argv[2]);
        if (!strcmp(argv[1], "-x")) {
            is_global = 1;
        }
        else if (!strcmp(argv[1], "-r")) {
            is_read_only = 1;
        }
        else if (!strcmp(argv[1], "-xr")) {
            is_global = 1;
            is_read_only = 1;
        }
    }
    else {
        return 1;
    }
    
    // 针对不同的属性参数，对 kvset 进行处理
    int kvsetlen = strlen(kvset);
    int whereequal = -1;
    // 尝试寻找 '='
    for (int i = 0; i < kvsetlen; i++) {
        if (kvset[i] == '=') {
            whereequal = i;
            break;
        }
    }
    // 如果未找到，说明没有设置 value ，以空字符串作为 value
    if (whereequal == -1) {
        strcpy(key, kvset);
        strcpy(value, "");
    }
    // 否则分别将 '=' 两边赋给 key 和 value
    else {
        for (int i = 0; i < whereequal; i++) {
            key[i] = kvset[i];
        }
        for (int i = whereequal + 1; i < kvsetlen; i++) {
            value[i - whereequal - 1] = kvset[i];
        }
    }

    syscall_put_envvar(key, value, is_global, is_read_only);
    return 0;
}

int unset(int argc, char **argv) {
    if (argc != 2) {
        return 1;
    }
    else {
        int r = syscall_del_envvar(argv[1]);
        if (r < 0) {
            return 1;
        }
        else {
            return 0;
        }
    }
}
```

### 支持在输入指令时使用 `left-arrow` 和 `right-arrow` 移动光标

接下来我们来到了控制显示的部分，这一部分内容基本全部都在 `sh.c` 中的 `readline()` 函数里完成。这个函数的作用就是将当前使用 `read()` 函数读出的字符写入 `buf` 中，再使用 `printf()` 函数将当前的内容输出至终端。在这一部分中，我们既要维护 `buf` 中内容的正确性，还要维护终端处当前指令和光标位置的显示。

`readline()` 函数原本是通过一个 for 循环，按顺序读入指令内容，功能实在可怜。现在我们需要打破按顺序读入，做到能够移动到任意位置进行插入和删除，所以需要对循环结构进行一些改造：

首先我们抛弃每循环自增 1 的倒霉孩子 `i` ，改用记录当前光标位置的 int 型变量 `wherenowchar` 以及当前读入字符的 char 型变量 `nowchar` 。另外，为了知道当前 `buf` 的尾部在哪，我们还需要维护一个 int 型变量 `allchar` 表示 `buf` 中当前所有字符的数量：

```c
// user/sh.c
void readline(char *buf, u_int n) {
    int r;
    int wherenowchar = 0, allchar = 0;
    char nowchar;
    while(allchar < n) {
        if ((r = read(0, &nowchar, 1)) != 1) {
            if (r < 0) {
                debugf("read error: %d\n", r);
            }
            exit();
        }
        if (nowchar == ...) {
            ...
        }
        else if (nowchar == ...) {
            ...
        }
        else {
            ...
        }
    }
    debugf("line too long\n");
    while ((r = read(0, &nowchar, 1)) == 1 && buf[0] != '\r' && buf[0] != '\n') {
        ;
    }
    buf[0] = 0;
}
```

接下来我们开始实现上面代码中省略号部分的内容。要实现使用左键和右键移动光标，我们首先需要知道如何读取左键和右键，也就是此时的 `nowchar` 应该是什么。在 c 语言中，方向键会被读取为连续 3 个字符，我们需要连续读取 3 次才能识别到当前字符，上下左右键对应的字符分别如下：

|操作|字符|
|:--:|:--:|
|up-arrow|\033 + [ + A|
|down-arrow|\033 + [ + B|
|right-arrow|\033 + [ + C|
|left-arrow|\033 + [ + D|

（这里的 \033 是一个单独的字符，代表的是八进制下的 33 ，即十进制下的 27 ，所以使用 \x1b 也是同样的，可以自由调换）

读入左键和右键时，`buf` 中的内容没有发生改变，只有 `wherenowchar` 会发生移动，同时终端处的光标位置会发生改变。通过 printf 出上述特殊的字符串，就可以实现终端处光标的移动。但是我们还需要注意以下几个问题：一是在边界处光标位置不应当发生移动；二是当我们按下方向键时，如果光标能够向当前方向移动，它自动就会移动，而不需要我们通过 printf 移动，我们的代码需要考虑这个因素，在上述不需要移动光标的情况下进行对冲。

事实上，光标的显示是一个非常复杂的问题，尤其在边界条件的情况下往往会变得非常诡异，所以写这一部分的时候应该多跑几次，根据实际情况出发解决问题：

```c
// user/sh.c
void readline(char *buf, u_int n) {
    ...
    while(allchar < n) {
        // 读入 '\033'
        if ((r = read(0, &nowchar, 1)) != 1) {
            ...
        }
        if (nowchar == ...) {
            ...
        }
        else if (nowchar == '\033') {
            // 读入 '['
            read(0, &nowchar, 1);
            // 读入 'A/B/C/D'
            read(0, &nowchar, 1);
            if (nowchar == 'A') {
                ...
            }
            else if (nowchar == 'B') {
                ...
            }
            else if (nowchar == 'C') {
                // 如果能右移光标，则 wherenowchar++
                // 此时不需要处理终端处的显示，终端的光标会自己右移一格
                if (wherenowchar < allchar) {
                    wherenowchar++;
                }
                // 否则需要将终端处的光标左移回来进行对冲
                else {
                    printf("\033[D");
                }
            }
            else if (nowchar == 'D') {
                // 如果能左移光标，则 wherenowchar--
                // 此时不需要处理终端处的显示，终端的光标会自己左移一格
                if (wherenowchar > 0) {
                    wherenowchar--;
                }
                // 否则需要将终端处的光标右移回来进行对冲
                else {
                    printf("\033[C");
                }
            }
        }
        else {
            ...
        }
    }
    ...
}
```

### 支持在输入指令时在任意位置插入和删除字符

这一部分需要我们更新原有代码中的两个逻辑：识别退格字符和其它字符。我们依旧需要维护 `buf` 数组以及相关的变量，和终端处的字符串和光标位置的显示。

对 `buf` 数组的维护比较简单，我们只需要在 `wherenowchar` 的位置处插入 `nowchar` ，或者删除这个位置的字符即可。虽然这两个操作的时间复杂度都是 O(n) ，但并不会导致时间爆炸，可以放心使用。

相比之下，终端处的显示就比较复杂了。在终端处，我们没有办法直接插入或删除一个字符，此时其它已经打印出来的位置不会发生改变。我们能够做的只有删除所有位置会发生改变的字符，并将其重新打印出来，来假装我们插入或者删除了一个字符。这里可能会用到一种新的操作 `\003[K` ，它能够删除当前光标位置右侧的所有字符。

另外，我们还需要注意两个新出现的问题：一是不可以使用其它操作直接清除整行内容，这回导致每行开头的 `$` 丢失（当然要是重新打印回来貌似也可以，我没试过）；二是在 printf 正常字符串之后光标会随之移动到刚刚 printf 出的字符串的尾部，所以我们在这部分中只要涉及到更改显示内容的情况，流程一般是 `向左移动光标/不移动光标 -> 删除光标后所有的内容 -> 打印新的内容 -> 向左移动光标` 。

```c
// user/sh.c
void readline(char *buf, u_int n) {
    ...
    while(allchar < n) {
        if ((r = read(0, &nowchar, 1)) != 1) {
            ...
        }
        // 这里注意 '\b' 是 backspace 键，0x7f 是 delete 键
        if (nowchar == '\b' || nowchar == 0x7f) {
            // 判断是否在最左侧
            if (wherenowchar > 0) {
                for (int i = wherenowchar; i < allchar; i++) {
                    buf[i - 1] = buf[i];
                }
                wherenowchar--;
                allchar--;
                buf[allchar] = 0;
                // 判断是否在最右侧
                // 我也不知道为什么要特判这个，但是不特判就会错
                if (wherenowchar == allchar) {
                    printf("\033[D\033[K");
                }
                else {
                    // 光标左移一格，删除右侧全部内容，输出新内容，光标左移回去
                    // \033[%dD 表示左移 %d 格，如 \033[5D 表示左移 5 格
                    printf("\033[D\033[K%s\033[%dD", buf + wherenowchar, allchar - wherenowchar);
                }
            }
        }
        else if (nowchar == ...) {
            ...
        }
        else {
            for (int i = allchar - 1; i >= wherenowchar; i--) {
                buf[i + 1] = buf[i];
            }
            buf[wherenowchar++] = nowchar;
            allchar++;
            buf[allchar] = 0;
            // 判断是否在最右侧
            if (wherenowchar < allchar) {
                // 删除右侧全部内容，输出新内容，光标左移回去
                printf("\033[K%s\033[%dD", buf + wherenowchar, allchar - wherenowchar);
            }
        }
    }
    ...
}
```

### 支持兼容不以 `.b` 结尾的外部指令

这里我们先实现一下这个小功能，休息一下，马上回来。在 `user/sh.c` 的 `runcmd()` 函数中，我们使用 `int child = spawn(argv[0], argv);` 这行代码 spawn 出了一个子进程，用来执行外部指令，而这里的 `argv[0]` 就是当前外部指令对应的 `.b` 文件的路径。为了兼容不含 `.b` 的外部指令路径，我们只需要在因为找不到指令文件路径而 spawn 失败的情况下，在 `argv[0]` 的后面加上一个 `.b` 字符串，再尝试 spawn 一次就好了。

但是刚才我将 `pwd` 指令偷偷改造成了外部指令，所以需要拿着 `pwd` 字符串假装输入了 `/pwd.b` 字符串，这就需要我们在加完 `.b` 之后还是找不到文件路径的情况下，再尝试在前面加上 `/` 后再次 spawn ，如法炮制即可。

其实如果不是为了适配“伪外部指令”，这个自动添加 `/` 的功能也值得一加，毕竟我们在调试的时候经常会想不起来加前面的那个 `/` ，正经人谁家指令之前还有个杠啊（笑哭）。

```c
// user/sh.c
void runcmd(char *s) {
    ...
    int child = spawn(argv[0], argv);
    if (child < 0) {
        char adddotb[1024] = {'\0'};
        strcpy(adddotb, (char *)argv[0]);
        strcpy(adddotb + strlen((char *)argv[0]), ".b");
        child = spawn(adddotb, argv);
        if (child < 0) {
            int dotlen = strlen(adddotb);
            for (int i = dotlen; i > 0; i--) {
                adddotb[i] = adddotb[i - 1];
            }
            adddotb[0] = '/';
            child = spawn(adddotb, argv);
        }
    }

    close_all();
    ...
}
```

### 支持 `ctrl-E` `ctrl-A` `ctrl-K` `ctrl-U` `ctrl-W` 等快捷键

吃完 `.b` 这个小零食，我们继续实现显示相关的部分。之前我们已经实现了左右键和自由插入删除，这几个快捷键只需要举一反三就可以轻松解决了。这里还是要先介绍一下如何读取这几个快捷键，在 c 语言中，`ctrl-A` 对应的字符是 `\001`（注意这是单独一个字符），`ctrl-B` 对应的字符是 `\002` ，依此类推（注意是八进制，当然十六进制也可以）。下面是上述所有快捷键对应的字符：

|操作|字符|
|:--:|:--:|
|ctrl-E|\005|
|ctrl-A|\001|
|ctrl-K|\013|
|ctrl-U|\025|
|ctrl-W|\027|

另外，我们还需要注意快捷键冲突的问题。如果在跳板机上完成挑战性任务的话，`ctrl-A` 和 `ctrl-W` 会出现快捷键冲突。可以在最开始写的时候把键位改为不会发生冲突的键位，在充分调试之后确认无误的情况下，再将快捷键改回。

```c
// user/sh.c
void readline(char *buf, u_int n) {
    ...
    while(allchar < n) {
        if ((r = read(0, &nowchar, 1)) != 1) {
            ...
        }
        if (nowchar == ...) {
            ...
        }
        // 我也不知道为什么会有这么多特判，反正不特判就不对
        else if (nowchar == '\005') {
            if (wherenowchar < allchar) {
                printf("\033[%dC", allchar - wherenowchar);
                wherenowchar = allchar;
            }
        }
        else if (nowchar == '\001') {
            if (wherenowchar > 0) {
                printf("\033[%dD", wherenowchar);
                wherenowchar = 0;
            }
        }
        else if (nowchar == '\013') {
            if (wherenowchar < allchar) {
                printf("\033[K");
                for (int i = wherenowchar; i < allchar; i++) {
                    buf[i] = 0;
                }
                allchar = wherenowchar;
            }
        }
        else if (nowchar == '\025') {
            if (wherenowchar > 0) {
                for (int i = wherenowchar; i < allchar; i++) {
                    buf[i - wherenowchar] = buf[i];
                }
                for (int i = allchar - wherenowchar; i < allchar; i++) {
                    buf[i] = 0;
                }
                if (wherenowchar == allchar) {
                    printf("\033[%dD\033[K", wherenowchar);
                }
                else {
                    printf("\033[%dD\033[K%s\033[%dD", wherenowchar, buf, allchar - wherenowchar);
                }
                allchar = allchar - wherenowchar;
                wherenowchar = 0;
            }
        }
        else if (nowchar == '\027') {
            if (wherenowchar > 0) {
                int flag = 0, wheredel = wherenowchar - 1;
                // 找到要被删除部分的起始位置
                while (wheredel >= 0 && (flag == 0 || buf[wheredel] != ' ')) {
                    if (flag == 0 && buf[wheredel] != ' ') {
                        flag = 1;
                    }
                    wheredel--;
                }
                wheredel++;
                for (int i = wherenowchar; i < allchar; i++) {
                    buf[i - wherenowchar + wheredel] = buf[i];
                }
                for (int i = allchar - wherenowchar + wheredel; i < allchar; i++) {
                    buf[i] = 0;
                }
                if (wherenowchar == allchar) {
                    printf("\033[%dD\033[K%s", wherenowchar, buf);
                }
                else {
                    printf("\033[%dD\033[K%s\033[%dD", wherenowchar, buf, allchar - wherenowchar);
                }
                allchar = allchar - wherenowchar + wheredel;
                wherenowchar = wheredel;
            }
        }
        else {
            ...
        }
    }
    ...
}
```

### 支持使用 `up-arrow` 和 `down-arrow` 回溯历史指令

为了回溯历史指令，我们首先要做的就是将所有历史指令存储起来。课程组的要求是将所有指令存储在位于 Shell 根目录下的 `/.mos_history` 文件中，但考虑从文件中读取某一行还是比较复杂，所以我们在 `user/sh.c` 中再以二维 char 型数组的形式保存一份备份，二者同时更新。

首先我们先来探讨 `/.mos_history` 的维护。在 Shell 启动时，我们在其根目录下直接使用 `touch()` 函数创建这个文件（我们目前还未实现这个函数，可以先去实现一下）。因为这里是直接调用了 `touch()` 函数，而不是将其写入 `buf` 后按回车执行，所以这次 touch 并不会被记录在历史中。

接下来在 `readline()` 函数中，我们修改读取到回车时的操作。首先使用 `open()` 函数以写和追加的方式打开文件（我们目前也未实现追加模式，可以先去实现一下追加重定向），获取 `/.mos_history` 的文件描述符，再使用 `write()` 函数向其中追加写入当前的 `buf` ，这样就完成了对 `/.mos_history` 的维护。

紧接着我们在 `user/sh.c` 里维护一个功能相同的数组，效仿对 `buf` 相关变量的修改，我们创建一个二维 char 型数组 `histories` ，并使用 int 型变量 `nowhistory` 和 `allhistory` 记录当前指令所处的行数。当每次我们按下回车时，当前 `buf` 中的指令都会被写到 `histories` 的最后一行，并且我们当前的 `nowhistory` 也会被重置到最后一行。

```c
// user/sh.c
char histories[1024][1024];
int allhistory = 0, nowhistory = 0;

void readline(char *buf, u_int n) {
    ...
    while(allchar < n) {
        if ((r = read(0, &nowchar, 1)) != 1) {
            ...
        }
        if (nowchar == ...) {
            ...
        }
        else if (nowchar == '\r' || nowchar == '\n') {
            buf[allchar] = 0;
            int fd = open("/.mos_history", O_APPEND | O_WRONLY);
            if (fd < 0) {
                exit();
            }
            write(fd, buf, allchar);
            write(fd, "\n", 1);
            close(fd);
            strcpy(histories[allhistory++], buf);
            nowhistory = allhistory;
            ...
            return;
        }
        else {
            ...
        }
    }
    ...
}

int main(int argc, char **argv) {
    ...
    touch("/.mos_history");
    for (;;) {
        ...
    }
    return 0;
}
```

下面我们来处理上键和下键的效果，在按下上键和下键时，我们需要同时修改 `nowhistory` 的值和终端的显示。当按下上键时，如果存在上一条指令，那么 `nowhistory--` ，并且将光标位置移到指令最前面，删除后面所有内容，重新输出上一条指令的全部内容（这里不需要再左移光标，因为切换指令后，光标默认在指令尾部），并将 `wherenowchar` 的值改为当前指令的尾部。下键也是同理，这样我们就完成了上键和下键的相应。

然而真的只是这样吗？

事实上，现实中指令的回溯涉及到非常多细节，例如：相邻两条完全相同的指令会被合并；修改历史指令后如果不执行，修改内容会被保存在历史指令中；修改历史指令后如果执行，修改内容不会保存在历史指令中，而是会单独成为当前的最后一条指令被保存；当前缓冲区内的指令被存储在历史的最后一条，可以自由访问，但一旦执行了历史指令，缓冲区内保存的指令就会丢失。等等。

如果我们仅以通过评测为目的的话，可以考虑只实现一部分细节。这其中我们必须要实现的就是上述中的后两个细节。第一个细节在刚才维护 `histories` 的时候已经实现了，但第二个细节还需要我们精心设计一下，考虑如何存储这条“看似存在，实则却不存在”的缓冲区内容。

当前 `histories` 中一共有 `allhistory` 条指令，那么理论上来说 `nowhistory` 的取值范围应该是 `[0, allhistory - 1]` ，但是实际上 `nowhistory` 也可以取到 `allhistory` 这个值，这就代表着目前处于缓冲区 `buf` 中的内容并不来自于历史指令，而是我们新输入的一条内容（当然这才是我们输入指令时的常态）。

所以，当我们离开这条指令时，我们需要将这条指令保存在下来；当我们再次回到这个位置时，我们就能够读取到这条保存下来的指令。但是这条指令不能保存在 `histories` ，更不能保存在文件 `/.mos_history` 中，因为 `histories` 里面保存的都是已经执行过的，不会再被移出历史的指令，而这条指令却面临着有其它历史指令被执行就会消失的风险，所以我们为其单开一个 char 型数组 `buf_save` ，防止与其它历史指令混淆。

加入 `buf_save` 数组后，当我们离开 `allhistory` 的位置时，我们除正常操作外，额外将当前指令写入 `buf_save` ；当我们再次回到 `allhistory` 的位置时，我们从 `buf_save` 中调入指令，否则从 `histories` 的相应位置调入指令。

```c
// user/sh.c
char buf_save[1024];
char histories[1024][1024];
int allhistory = 0, nowhistory = 0;

void readline(char *buf, u_int n) {
    ...
    while(allchar < n) {
        if ((r = read(0, &nowchar, 1)) != 1) {
            ...
        }
        if (nowchar == ...) {
            ...
        }
        // 读 '\033'
        else if (nowchar == '\033') {
            // 读 '['
            read(0, &nowchar, 1);
            // 读 'A/B/C/D'
            read(0, &nowchar, 1);
            if (nowchar == 'A') {
                // 此时光标会自动上移一格，需要手动下移一格对冲
                printf("\033[B");
                // 判断是否有上一条指令
                if (nowhistory > 0) {
                    // 如果即将离开 allhistory 的位置，则将 buf 中内容保存在 buf_save 中
                    if (nowhistory == allhistory) {
                        for (int i = 0; i < allchar; i++) {
                            buf_save[i] = buf[i];
                        }
                        buf_save[allchar] = '\0';
                    }
                    // 清空当前缓冲区 buf
                    for (int i = 0; i < allchar; i++) {
                        buf[i] = '\0';
                    }
                    // 从 histories 中载入上一条指令
                    strcpy(buf, histories[--nowhistory]);
                    // 删除当前显示的指令，输出上一条指令
                    // 这里又有一个奇怪的边界值特判
                    if (wherenowchar > 0) {
                        printf("\033[%dD", wherenowchar);
                    }
                    printf("\033[K%s", buf);
                    wherenowchar = strlen(buf);
                    allchar  = strlen(buf);
                }
            }
            else if (nowchar == 'B') {
                // 判断是否有下一条指令
                if (nowhistory < allhistory) {
                    // 清空当前缓冲区 buf
                    for (int i = 0; i < allchar; i++) {
                        buf[i] = '\0';
                    }
                    // 如果即将回到 allhistory 的位置，从 buf_save 将指令载入到 buf 中
                    if (nowhistory == allhistory - 1) {
                        strcpy(buf, buf_save);
                        nowhistory++;
                    }
                    // 否则从 histories 中载入下一条指令
                    else {
                        strcpy(buf, histories[++nowhistory]);
                    }
                    // 删除当前显示的指令，输出下一条指令
                    // 这里还有一个奇怪的边界值特判
                    if (wherenowchar > 0) {
                        printf("\033[%dD", wherenowchar);
                    }
                    printf("\033[K%s", buf);
                    wherenowchar = strlen(buf);
                    allchar  = strlen(buf);
                }
            }
            ...
        }
        else {
            ...
        }
    }
    ...
}
```

### 加入内建指令 `history` 

这一步就非常简单了，我们之前已经实现过很多内建指令了，使用 `history` 指令读取 `/.mos_history` 文件并输出即可。

首先还是在 `user/sh.c` 中的 `is_built_in_command()` 函数和 `runcmd()` 函数中加入 `history` 指令的分支判断，再在 `user/sh.c` 中编写 `history()` 函数执行指令：

```c
// user/sh.c
int history(int argc, char **argv) {
    int r;
    // 以只读模式打开 /.mos_history ，获取文件描述符
    int fd = open("/.mos_history", O_RDONLY);
    char buffer[8192];
    if (fd < 0) {
        return 1;
    }
    // 将文件中所有内容读取到 buffer 中
    r = read(fd, buffer, sizeof buffer);
    if (r < 0) {
        return 1;
    }
    // 输出 buffer 中的内容
    printf("%s", buffer);
    return 0;
}
```

### 支持使用 `#` 进行注释

依旧是奖励关，在执行 `buf` 中的指令之前，把第一个 `#` 以及后面的所有内容全部删掉即可。唯一需要注意的是这个动作必须发生在将该指令保存在历史记录中之后。

```c
// user/sh.c
// 请忽略这个难绷的命名方式()
void replace_well(char *buffer) {
    int haswell = 0;
    int buflen = strlen(buffer);
    for (int i = 0; i < buflen; i++) {
        if (buffer[i] == '#') {
            haswell = 1;
        }
        if (haswell == 1) {
            buffer[i] = 0;
        }
    }
}

int main(int argc, char **argv) {
    ...
    for (;;) {
        ...
        replace_well(buf);
        replace_envvar(buf);

        if (!is_built_in_command(buf)) {
            ...
        }
        else {
            runcmd(buf);
        }
    }
    return 0;
}
```

### 支持反引号 `` ` `` 

从这里开始，我们即将进入本次挑战性任务的最后阶段。在这个阶段，我们遇到的任务开始更加考验我们对整个操作系统的全面理解，会遇到很多魔王关，反引号就是其中的第一个。

如果仔细思考，我们就会发现，把反引号的内容摘出来并单独执行，其实并不是一件难事，真正困难的是如何取得反引号中的内容输出的结果，并写回原指令中，这就涉及到了内容的跨进程传递。

提到内容的跨进程传递，我们就很容易能够想到管道，市面上很多写法也是这样操作的。然而这种写法还是有点太吃操作了，有没有更简单的做法呢？有的兄弟，有的！

如果内容在父子进程之间通过管道传递还是太难了，我们为什么不找一个便宜实惠好用的第三方来保管传递的信息呢？没错，就是文件进程！只要我们将反引号中指令的输出重定向到文件中，再让原指令读取这个文件，就可以完美实现信息的传递了！

我们在 `user/sh.c` 中创建一个 `replace_backquote()` 函数，由这个函数执行上述操作。首先，我们需要取出反引号中的内容，这部分比较简单，就不多赘述了。取出后，我们在 Shell 的根目录创建 `/.backquote_temp` 文件（创建文件我们还是没有实现，可以先实现一下），将反引号中的指令后面添加重定向 ` > /.backquote_temp` ，仿照主函数执行这条反引号中的指令，这样这条指令执行后的结果就已经输出在 `/.backquote_temp` 中了。

接下来，我们只要以只读模式打开 `/.backquote_temp` ，从其中读取内容，写回原指令中反引号的位置，就完成了对 buf 中反引号的替换：

```c
// user/sh.c
void replace_backquote(char *buffer) {
    char res[1024];
    int allres = 0;
    int buflen = strlen(buf);
    for (int i = 0; i < buflen; i++) {
        if (buffer[i] == '`') {
            // 创建 /.backquote_temp 文件
            touch("/.backquote_temp");
            char innerbuf[1024];
            int innerbuflen = 0;
            // 将反引号中的指令写入 innerbuf 中
            for (int j = i + 1; j < buflen && buffer[j] != '`'; j++) {
                innerbuf[innerbuflen++] = buffer[j];
            }
            // 将 innerbuf 的输出重定向至 /.backquote_temp
            strcpy(innerbuf + innerbuflen, " > /.backquote_temp");
            i += innerbuflen + 1;

            // 仿照主函数执行 innerbuf
            int r;
            if (!is_built_in_command(innerbuf)) {
                if ((r = fork()) < 0) {
                    user_panic("fork: %d", r);
                }
                if (r == 0) {
                    runcmd(innerbuf);
                    exit();
                } else {
                    wait(r);
                }
            }
            else {
                runcmd(innerbuf);
            }

            char innerres[1024] = {'\0'};
            // 使用只读模式打开 /.backquote_temp ，获取文件描述符
            int fd = open("/.backquote_temp", O_RDONLY);
            if (fd < 0) {
                user_panic("can't find /.backquote_temp");
            }
            // 将 /.backquote_temp 中的内容读入 innerres 中
            r = read(fd, innerres, sizeof innerres);
            if (r < 0) {
                user_panic("can't read /.backquote_temp");
            }
            // 有 open 必有 close
            close(fd);
            int innerreslen = strlen(innerres);
            // 将 innerres 的内容写入 res 中
            for (int j = 0; j < innerreslen; j++) {
                res[allres++] = innerres[j];
            }

            // 卸磨杀驴，删除 /.backquote_temp 文件
            rm("/.backquote_temp", 0);
        }
        else {
            res[allres++] = buffer[i];
        }
    }
    res[allres] = '\0';
    strcpy(buffer,res);
}

int main(int argc, char **argv) {
    ...
    for (;;) {
        ...
        replace_well(buf);
        replace_envvar(buf);
        replace_backquote(buf);

        if (!is_built_in_command(buf)) {
            ...
        }
        else {
            runcmd(buf);
        }
    }
    return 0;
}
```

（其实把 `pwd` 指令写成外部指令就是为了在这里能够使用，内建指令重定向会出现莫名其妙的问题，我不会修）

### 支持使用分号 `;` 实现一行多指令

虽然分号的要求看起来云里雾里，但只要发现它和管道很像，只是不需要在两侧传递数据，就能够仿照管道，轻松将其秒掉了：

```c
// user/sh.c
int parsecmd(char **argv, int *rightpipe) {
    int argc = 0;
    while (1) {
        char *t;
        int fd, r;
        int c = gettoken(0, &t);
        switch (c) {
        ...
        case ';':
            // 使用 fork 将指令分成两部分
            r = fork();
            if (r < 0) {
                debugf("fork: %d\n", r);
            }
            *rightpipe = r;
            // 子进程（左侧部分）执行结束返回
            if (r == 0) {
                return argc;
            } else {
                // 等待子进程结束
                wait(*rightpipe);
                // 父进程（右侧部分）开始执行
                return parsecmd(argv, rightpipe);
            }
            break;
        ...
        }
    }
    return argc;
}
```

### 支持使用 `&&` 和 `||` 实现指令条件执行

（在实现这一步之前，必须先实现所有的外部指令 `mkdir` `touch` `rm` ）
根据经验，大家普遍认为这是这是最难最难的魔王关，关底 boss 级别的水准，其思路难度和代码量都已经达到了本次挑战性任务的巅峰（害怕）。

但是！只要沿用我反引号一节的实现方法，完成这个任务也并不是一件难事！且听我娓娓道来:

首先我们要做的是让 `user/sh.c` 中的 `parsecmd()` 函数能够识别双字符符号。在 `_gettoken()` 函数中，`t` 表示当前 token 的类型，`p1` 表示指向当前 token 第一个字符的二级指针，`p2` 表示指向当前 token 结束后第一个字符的二级指针。若当前 token 为特殊符号，`t` 就等于这个特殊符号本身，即 `<` `>` `|` `;` 等，但实际上 `t` 也可以任意定义，只要在 `parsecmd()` 函数的 switch-case 中能够将分支对应上即可。

检查 `user/sh.c` 顶部的宏定义 `#define SYMBOLS "<|>&;()"`，确保我们要识别的 `&&` `||` `>>` 的第一个字符 `&` `|` `>` 均在其中。于是当我们读到它们的第一个字符时，我需要再判断它们后面的一个字符是否相同，如果相同就改变 `t` 的类型和 `p2` 的位置，将当前 token 变为长度为 2 的新 token ：

```c
// user/sh.c
int _gettoken(char *s, char **p1, char **p2) {
    ...
    if (strchr(SYMBOLS, *s)) {
        int t = *s;
        *p1 = s;
        *s++ = 0;
        // r: 追加重定向
        if (t == '>' && *s == '>') {
            t = 'r';
            s++;
        }
        // a: 条件执行
        else if (t == '&' && *s == '&') {
            t = 'a';
            s++;
        }
        // o: 条件不执行
        else if (t == '|' && *s == '|') {
            t = 'o';
            s++;
        }
        *p2 = s;
        return t;
    }
    ...
}
```

在 `parsecmd()` 函数中，我们需要对其进行处理。根据刚才的经验我们不难看出，`&&` 和 `||` 其实和 `;` 是相同的，都是在一行连续实现多条指令，只不过这两个操作中后面的指令不一定执不执行。

如何判断后面的指令是否执行？现有的操作一般是改造 `exit()` 函数，使子进程（左侧指令）结束时通过返回值将其层层传递至父进程（右侧指令）。NO!!!!!!!!!! 不要这样做！效仿我刚才介绍的反引号实现方法，在子进程结束时，只需要将返回值写入 Shell 中的一个文件 `/.return_temp` 中，此时父进程只要从该文件中读取内容，即可无痛获取到子进程的返回值！

```c
// user/sh.c
int parsecmd(char **argv, int *rightpipe) {
    int argc = 0;
    while (1) {
        char *t;
        int fd, r;
        int c = gettoken(0, &t);
        switch (c) {
        ...
        case 'a':
            // 使用 fork 将指令分成两部分
            r = fork();
            if (r < 0) {
                debugf("fork: %d\n", r);
            }
            *rightpipe = r;
            // 子进程（左侧部分）执行结束返回
            if (r == 0) {
                return argc;
            } else {
                // 父进程等待子进程结束
                wait(*rightpipe);
                // 以只读模式打开 /.return_temp ，获取文件描述符
                int fd = open("/.return_temp", O_RDONLY);
                if (fd < 0) {
                    user_panic("can't find /.return_temp");
                }
                char c;
                // 将子进程（左侧部分）的返回值读入 c 中
                r = read(fd, &c, 1);
                if (r < 0) {
                    user_panic("can't read /.return_temp");
                }
                // 有 open 必有 close
                close(fd);
                // 如果子进程（左侧部分）返回值为 0
                if (c == '0') {
                    // 父进程（右侧部分）开始执行
                    return parsecmd(argv, rightpipe);
                }
                // 否则父进程（右侧部分）直接退出
                else {
                    exit();
                }
            }
            break;
        case 'o':
            // 使用 fork 将指令分成两部分
            r = fork();
            if (r < 0) {
                debugf("fork: %d\n", r);
            }
            *rightpipe = r;
            // 子进程（左侧部分）执行结束返回
            if (r == 0) {
                    return argc;
            } else {
                    // 父进程等待子进程结束
                    wait(*rightpipe);
                    // 以只读模式打开 /.return_temp ，获取文件描述符
                    int fd = open("/.return_temp", O_RDONLY);
                    if (fd < 0) {
                        user_panic("can't find /.return_temp");
                    }
                    char c;
                    // 将子进程（左侧部分）的返回值读入 c 中
                    r = read(fd, &c, 1);
                    if (r < 0) {
                        user_panic("can't read /.return_temp");
                    }
                    // 有 open 必有 close
                    close(fd);
                    // 如果子进程（左侧部分）返回值不为 0
                    if (c != '0') {
                        // 父进程（右侧部分）开始执行
                        return parsecmd(argv, rightpipe);
                    }
                    // 否则父进程（右侧部分）直接退出
                    else {
                        exit();
                    }
            }
            break;
        ...
        }
    }
    return argc;
}
```

最后一步，我们只需要在执行命令时将返回值写入 Shell 根目录的 `/.return_temp` 文件中即可。这一步我将在下一节进行介绍。

轻轻松松，最难关底 boss 就这样被拿下了，不是吗？

### 加入外部指令 `mkdir` `touch` `rm` 和内建指令 `exit` 

首先，我们先来解决上一节遗留下来的问题，我们可以编写一个函数 `note_return()` ，输入一个返回值，它能够自行将这个返回值写在 `/.return_temp` 文件中。为了使所有指令都能调用它，我们将其放在 `/user/lib` 文件夹的随便一个文件中，在再 `user/include/lib.h` 中注册这个函数即可：

```c
// user/lib/file.c
void note_return(int r) {
    // 以只写模式和覆盖模式打开 /.return_temp ，获取文件描述符
    int fd = open("/.return_temp", O_WRONLY | O_TRUNC);
    if (fd < 0) {
        user_panic("can't find /.return_temp");
    }
    char c = r + '0';
    // 将返回值对应的字符写入 /.return_temp 中
    r = write(fd, &c, 1);
    if (r < 0) {
        user_panic("can't read /.return_temp");
    }
    // 有 open 必有 close
    close(fd);
}

// user/include/lib.h
void note_return(int r);
```

在 `user/sh.c` 中，我们在 Shell 启动的开始创建一个 `/.return_temp` 文件供后续使用（不需要每次都删除这个文件，因为每次写时会自动覆盖上次的内容）。其实也可以不创建，在打开该文件时加上 `O_CREAT` 模式，就可以在文件不存在时先自动创建这个文件：

```c
// user/sh.c
int main(int argc, char **argv) {
    ...
    touch("/.mos_history");
    touch("/.return_temp");
    for (;;) {
        ...
    }
    return 0;
}
```

下面我们就开始正式加入上述这些指令。对于外部指令，我们只需要在 `user` 文件夹中添加其对应的 `.c` 文件，再在 `user/new.mk` 中将其对应的 `.b` 文件加入即可。

与之前不同的一点是，我们可以将这些指令的核心部分编写成函数封装在 `user/lib` 的文件中，并在 `user/include/lib.h` 中对其进行声明，这样我们就可以在用户态的所有文件中使用这些函数了，例如上一段代码中我们就在 `user/sh.c` 中使用了 `touch()` 函数：

```c
// user/lib/file.c
int mkdir(const char *path, int p) {
    char abspath[1024];
    // 将相对路径转换为绝对路径
    rel2abs(path, abspath);

    int r = 0;
    // 如果没有 -p 参数，直接打开即可
    if (p == 0) {
        // 这里用到了两个新的模式，后面会介绍到
        r = open(abspath, O_MKDIR | O_EXCL);
    }
    // 如果有 -p 参数
    else {
        char nowpath[1024] = {'/'};
        int len = strlen(abspath);
        for (int i = 1; i <= len; i++) {
            if (i == len || abspath[i] == '/') {
                // 从根目录开始查找，每遇到一个 '/' 或字符串结束，都会尝试创建当前的目录
                r = open(abspath, O_MKDIR);
                nowpath[i] = '/';
            }
            else {
                nowpath[i] = abspath[i];
            }
        }
    }
    return r;
}

int touch(const char *path) {
    char abspath[1024];
    // 将相对路径转换为绝对路径
    rel2abs(path, abspath);

    int r;
    r = open(abspath, O_CREAT | O_EXCL);
    return r;
}

int rm(const char *path, int r) {
    char abspath[1024];
    // 将相对路径转换为绝对路径
    rel2abs(path, abspath);
    
    int rr;
    struct Stat st;
    rr = open(abspath, O_RDONLY);
    if (rr < 0) {
        return rr;
    }
    else {
        close(rr);
        // 读取文件状态，检查是否为目录
        stat(abspath, &st);
        int isdir = st.st_isdir;
        // 如果为目录且没有 -r 参数，则报错
        if (isdir && r == 0) {
            return -114514;
        }
        else {
            remove(abspath);
        }
    }
    return rr;
}

// user/mkdir.c
#include <lib.h>

int main(int argc, char **argv) {
    int r;
    // 此时只有一个参数，说明没有 -p 参数
    if (argc == 2) {
        r = mkdir(argv[1], 0);
        // 如果文件已经存在
        if (r == -E_FILE_EXISTS) {
            printf("mkdir: cannot create directory '%s': File exists\n", argv[1]);
            note_return(1);
            return 1;
        }
        // 如果上一级目录不存在
        else if (r < 0) {
            printf("mkdir: cannot create directory '%s': No such file or directory\n", argv[1]);
            note_return(1);
            return 1;
        }
        // 正常情况
        else {
            close(r);
            note_return(0);
            return 0;
        }
    }
    // 此时有两个参数，说明有 -p 参数
    else if (argc == 3) {
        r = mkdir(argv[2], 1);
        close(r);
        note_return(0);
        return 0;
    }
    note_return(1);
    return 1;
}

// user/touch.c
#include <lib.h>

int main(int argc, char **argv) {
    int r;
    if (argc == 2) {
        r = touch(argv[1]);
        // 如果文件已经存在
        if (r == -E_FILE_EXISTS) {
            note_return(0);
            return 0;
        }
        // 如果上一级目录不存在
        else if (r < 0) {
            printf("touch: cannot touch '%s': No such file or directory\n", argv[1]);
            note_return(1);
            return 1;
        }
        // 正常情况
        else {
            close(r);
            note_return(0);
            return 0;
        }
    }
    note_return(1);
    return 1;
}

// user/rm.c
#include <lib.h>

int main(int argc, char **argv) {
    int r;
    // 此时只有一个参数，说明没有 -r, -rf
    if (argc == 2) {
        r = rm(argv[1], 0);
        // 如果该文件是目录
        if (r == -114514) {
            printf("rm: cannot remove '%s': Is a directory\n", argv[1]);
            note_return(1);
            return 1;
        }
        // 如果该文件不存在
        else if (r < 0) {
            printf("rm: cannot remove '%s': No such file or directory\n", argv[1]);
            note_return(1);
            return 1;
        }
        // 正常情况
        else {
            note_return(0);
            return 0;
        }
    }
    // 如果有两个参数，说明有 -r, -rf
    else if (argc == 3) {
        r = rm(argv[2], 1);
        // 如果该文件不存在
        if (r < 0) {
            // 如果没有 -rf 参数
            if (strcmp(argv[1], "-rf")) {
                printf("rm: cannot remove '%s': No such file or directory\n", argv[2]);
                note_return(1);
                return 1;
            }
            // 如果有 -rf 参数
            else {
                note_return(0);
                return 0;
            }
        }
        // 正常情况
        else {
            note_return(0);
            return 0;
        }
    }
    return 1;
}
```

```makefile
# user/new.mk
INITAPPS +=

USERLIB +=

USERAPPS += mkdir.b \
            touch.b \
            rm.b    \
            pwd.b
```

这里我们对新增的三个外部指令在返回前加入了 `note_return()` ，从而向 `/.return_temp` 文件传递了返回值，我们也可以按需求对其它的所有外部指令和内部指令添加返回值传递，毋庸置疑。

刚才我们在实现 `mkdir` 和 `touch` 的过程中使用了新的模式 `O_MKDIR` 和 `O_EXCL` ，在 `user/include/lib.h` 中能够找到它们的定义：

```c
// user/include/lib.h
// Unimplemented open modes
#define O_EXCL 0x0400  /* error if already exists */
#define O_MKDIR 0x0800 /* create directory, not regular file */
```

可以看出，`O_MKDIR` 和 `O_CREAT` 的作用相似，后者是在找不到文件的时候创建文件，而前者则是在找不到目录的时候创建目录；`O_EXCL` 的作用则是当文件已经存在时直接报错。

然而，我们还应该注意到二者上方的 `Unimplemented open modes` ，实际上，这两个模式根本就没有在我们的代码中实现过，只是给出了定义而已，这或许是课程组留给我们的一些小提示吧。

要实现这两个内容，我们需要进入文件系统，在 `fs/serv.c` 的 `serv_open()` 函数中给出相关的实现。对于 `O_MKDIR` 模式，我们完全可以仿照 `O_CREAT` 的部分给出实现，只不过在后续需要将文件的 `f_type` 改为 `FTYPE_DIR` 。对于 `O_EXCL` 模式，只需要在创建文件时识别到 `-E_FILE_EXISTS` 错误时返回即可。

```c
// fs/serv.c
void serve_open(u_int envid, struct Fsreq_open *rq) {
    struct File *f;
    struct Filefd *ff;
    int r;
    struct Open *o;

    // Find a file id.
    if ((r = open_alloc(&o)) < 0) {
        ipc_send(envid, r, 0, 0);
        return;
    }

    // 对 O_CREAT 和 O_EXCL 进行处理
    if ((rq->req_omode & O_CREAT) && (r = file_create(rq->req_path, &f)) < 0) {
        // 文件的上一级目录不存在，创建文件失败
        if (r != -E_FILE_EXISTS) {
            ipc_send(envid, r, 0, 0);
            return;
        }
        // 文件已经存在
        else if (rq->req_omode & O_EXCL) {
            ipc_send(envid, r, 0, 0);
            return;
        }
    }

    // 对 O_MKDIR 和 O_EXCL 进行处理
    if ((rq->req_omode & O_MKDIR) && (r = file_create(rq->req_path, &f)) < 0) {
        // 文件的上一级目录不存在，创建文件失败
        if (r != -E_FILE_EXISTS) {
            ipc_send(envid, r, 0, 0);
            return;
        }
        // 文件已经存在
        else if (rq->req_omode & O_EXCL) {
            ipc_send(envid, r, 0, 0);
            return;
        }
    }

    // Open the file.
    if ((r = file_open(rq->req_path, &f)) < 0) {
        ipc_send(envid, r, 0, 0);
        return;
    }

    // 如果模式为 O_MKDIR ，则将 f->f_type 设置为 FTYPE_DIR
    if (rq->req_omode & O_MKDIR) {
        f->f_type = FTYPE_DIR;
    }
    ...
}
```

最后是内建指令 `exit` ，这个指令就非常简单了，我们甚至不需要为其单开一个函数解决，在 `user/sh.c` 中，我们照例在 `is_built_in_command()` 函数和 `runcmd()` 函数的判断处添加 `exit` 指令，在 `runcmd()` 函数中，我们可以直接在 `return` 之前加上 `exit()` 跳出当前进程，即可直接实现 `exit` 指令的功能：

```c
// user/sh.c
void runcmd(char *s) {
    ...
    if (...) {
        ...
    }
    else if (!strcmp(argv[0], "exit")) {
        exit();
        return;
    }
    ...
}

int is_built_in_command(char *buffer) {
    ...
    if (...) {
        ...
    }
    else if (!strcmp(cmd, "exit")) {
        return 1;
    }
    else {
        return 0;
    }
}
```

### 支持使用 `>>` 实现追加重定向

不难想到，追加重定向与重定向肯定是十分相似的，其实二者只是在打开文件的模式上有差别：

```c
// user/sh.c
int parsecmd(char **argv, int *rightpipe) {
    int argc = 0;
    while (1) {
        char *t;
        int fd, r;
        int c = gettoken(0, &t);
        switch (c) {
        ...
        case '>':
            if (gettoken(0, &t) != 'w') {
                debugf("syntax error: > not followed by word\n");
                exit();
            }

            fd = open(t, O_WRONLY | O_CREAT | O_TRUNC);
            if (fd < 0) {
                debugf("failed to open '%s'\n", t);
                exit();
            }
            dup(fd, 1);
            close(fd);

            break;
        case 'r':
            if (gettoken(0, &t) != 'w') {
                debugf("syntax error: >> not followed by word\n");
                exit();
            }
            
            fd = open(t, O_WRONLY | O_CREAT | O_APPEND);
            if (fd < 0) {
                debugf("failed to open '%s'\n", t);
                exit();
            }
            dup(fd, 1);
            close(fd);
            break;
        ...
        }
    }
    return argc;
}
```

（这里的 `r` 代表追加重定向，在实现 `&&` 和 `||` 的 token 解析时顺手实现的）

可以看到，追加重定向的打开模式由 `O_TRUNC` 变为了 `O_APPEND` ，这是一个全新的模式，需要我们自行添加。

联想刚才实现 `O_MKDIR` 和 `O_EXCL` 的过程，首先我们在 `user/include/lib.h` 中添加 `O_APPEND` 的宏定义，紧接着在 `fs/serv.c` 中修改 `serv_open()` 函数，修改打开文件时的偏移，即可实现在原文件的末尾进行添加的功能：

```c
// user/include/lib.h
#define O_APPEND 0x0004  /* write after original text */

// fs/serv.c
void serve_open(u_int envid, struct Fsreq_open *rq) {
    struct File *f;
    struct Filefd *ff;
    int r;
    struct Open *o;

    ...

    // If mode include O_APPEND, set offset to file size
    if (rq->req_omode & O_APPEND) {
        // 当前偏移设置为将文件大小
        ff->f_fd.fd_offset = f->f_size;
    }

    ipc_send(envid, 0, o->o_ff, PTE_D | PTE_LIBRARY);
}
```

到这里，我们就已经实现了全部的要求，可喜可贺，可喜可贺！

## 写在后面的话

不知道为什么，今年的 Shell 挑战性任务比往年题量要大得多、难得多，导致我在紧张的期末周和繁忙的招生任务中，凭借着每天只睡四小时的骇人睡眠时长，花费整整一周写完了整个任务。

2025 年 6 月 27 日凌晨 2:53:33 ，当评测界面出现绿色的 100 的时候，我疯了，发了两个月以来的第一条朋友圈。我是非常不经常发朋友圈的，但我是真疯了。

但是话又说回来，完成整个任务之后，我觉得整个挑战性任务设置得确实很有水平，用一系列任务把整个学期的大部分知识点都串联了起来。

从 lab 3 的修改 PCB ，到 lab 4 的添加 syscall 和修改 exofork ，再到 lab 5 的文件系统操作，最后到 lab 6 的 Shell ，我确确实实地体会到了我对 MOS 操作系统的认知从一盘散沙逐渐聚起，我现在觉得我甚至能和 lab 5-extra 碰一碰（然而提交已经截止，完全看不到了，taxi 了）。

更可惜的是，我在这门课程已经全部抬走之后，才真正参透很多其中的精髓，有一种在弥留之际突然醒悟，回看自己愚蠢的一生的无奈和哀伤。

到这里，我迷茫的大二生活基本就已经画上句号了。So, in case I don't see you, good afternoon, good evening, and good night.

## 致谢

感谢以下学长和同学，你们的博客和源代码为我提供了非常丰富的灵感和思路（排名不分先后）：

CookedBear 学长：
https://cookedbear.top/p/28193.html; https://github.com/CookedBear/BUAA-OS-2023/

Y(t) 学长：
https://github.com/zhangyitonggg/BUAA-OS-challenge/

Lazyfish 同学：
https://lazyfish-lc.github.io/2025/06/16/BUAA-OS-shell-challenge/

wrongization 同学：
https://wrongization.site/2025/06/18/os-shell.html
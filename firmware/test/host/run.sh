#!/usr/bin/env sh
# Builds and runs the host tests. Needs a C compiler: gcc/clang on PATH, or
#   pip install ziglang  and  CC="python -m ziglang cc" sh run.sh
# Pass -v to print every per-second estimator line.
set -e
cd "$(dirname "$0")"
CC="${CC:-cc}"
FLAGS="-std=c11 -O1 -Wall -Werror -Wno-unused-parameter -Wno-unused-function -I stubs -I support -I ../../src"
SRC=../../src

build() {   # build <name> <sources...>
    name=$1
    shift
    $CC $FLAGS "$name.c" support/host_stubs.c "$@" -lm -o "$name.exe"
}

build test_csi_window "$SRC/csi_window.c"
build test_estimator "$SRC/estimator.c"
build test_commands "$SRC/commands.c" "$SRC/estimator.c"
build test_pipeline "$SRC/csi_window.c" "$SRC/estimator.c"
build test_csi_frame "$SRC/csi_frame.c"

failed=0
for t in test_csi_window test_estimator test_commands test_pipeline test_csi_frame; do
    echo "########## $t"
    ./"$t.exe" "$@" || failed=$((failed + 1))
done
echo "########## check_csi_frame.py"
python3 check_csi_frame.py || python check_csi_frame.py || failed=$((failed + 1))
echo
if [ "$failed" -eq 0 ]; then
    echo "ALL HOST TESTS PASSED"
else
    echo "$failed TEST PROGRAM(S) FAILED"
fi
exit "$failed"

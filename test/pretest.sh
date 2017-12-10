#!/usr/bin/env sh

if [ ! -f "test/fixture.bin" ]; then
  curl -o test/fixture.bin https://raw.githubusercontent.com/watson/libmodes-test-fixtures/954f00ca11e3ddf8b618838e1acb4c2c40496660/dump.bin
fi

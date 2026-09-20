#!/usr/bin/env bash
#
# 打包。双击运行，或在终端里执行：bash 打包.command
#
# 输出两样东西：
#   dist/面试鸭AI复习助手/          ← 可以直接「加载已解压的扩展程序」的文件夹
#   面试鸭AI复习助手-vX.Y.Z.zip     ← 分享用的压缩包（对方需要先解压再加载）
#
# 只在 dist/ 下生成运行时需要的文件，dev/ 里的开发工具、测试、页面夹具都不进去。

set -euo pipefail

cd "$(dirname "$0")"

NAME="面试鸭AI复习助手"
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
DIST="dist/${NAME}"
ZIP="${NAME}-v${VERSION}.zip"

rm -rf dist "$ZIP"
mkdir -p "$DIST"

cp -R manifest.json background.js offscreen.html offscreen.js \
      options.html options.css options.js popup.html popup.js \
      shared content icons "$DIST/"

# 去掉 macOS 的元数据文件，别跟着一起发出去
find "$DIST" -name '.DS_Store' -delete

# 从 dist 里面打包，这样解压出来就是一个名字正确的文件夹，不用再手工改名
(cd dist && zip -r "../${ZIP}" "${NAME}" -x '*.DS_Store' > /dev/null)

echo "完成。"
echo
echo "  可直接加载的文件夹："
echo "    $(pwd)/${DIST}"
echo
echo "  分享给别人用的压缩包："
echo "    $(pwd)/${ZIP}  （$(du -h "$ZIP" | cut -f1)）"
echo
echo "怎么装（Chrome 或 Edge）："
echo "  1. 地址栏输入 chrome://extensions（Edge 是 edge://extensions）"
echo "  2. 打开右上角的「开发者模式」"
echo "  3. 点「加载已解压的扩展程序」"
echo "  4. 选中上面那个【文件夹】—— 注意不是 zip 文件，Chrome 不会自动解压"
echo
echo "如果拿到的是 zip，先双击解压出文件夹，再按第 3、4 步操作。"

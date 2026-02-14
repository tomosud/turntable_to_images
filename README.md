# turntable_to_images

「動画をブラウザで再生しながら縮小フレームを吸い出す → OpenCV.js（Worker内）でFarneback光学フロー → グリッド中央値で角速度ω推定→積分でθ→等角度でフレーム選択 → ZipでDL」。


もしOpenCV.jsの読み込みが失敗したら（たまにある）

原因は「Worker内で docs.opencv.org から opencv.wasm を取るときの挙動」だったりする。

その場合はOpenCVをリポジトリに同梱するのが確実：

ここから2ファイルを落として repo 直下に置く

opencv.js

opencv.wasm

worker.js の importScripts(...) をこれに変更

importScripts("./opencv.js");


それだけでOK（WASMは同じ場所から相対ロードされる）



使い方のコツ（失敗しにくい設定）

解析解像度（長辺）: 480 くらいがバランス良い

グリッド間隔: 24〜32（速さ優先なら32）

中心はなるべく正確にクリック（ズレると角速度推定が崩れる）

料理が「のっぺり」でフローが弱い場合は

解析解像度を 640 に上げる

グリッドを 16〜24 にする
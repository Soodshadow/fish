' fish 守护进程隐藏启动器（注册表 Run 使用）
' 登录时由 Windows 执行 → 正常用户权限 → 拉起 SnowLuma/DSH/桥接
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Program Files\nodejs\node.exe"" ""D:\fish\qq-bridge\tools\guard-daemon.mjs""", 0, False

' fish/snow 隐藏启动器：后台运行 SnowLuma，无窗口
' 由用户双击（或启动项/桌面快捷方式）调用 → 正常用户权限

Option Explicit
Dim ws, fso, baseDir, nodeExe, entry, cmd

Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = baseDir & "\node.exe"
entry = baseDir & "\index.mjs"

If Not fso.FileExists(nodeExe) Then
  MsgBox "找不到 node.exe: " & nodeExe, 16, "SnowLuma 启动失败"
  WScript.Quit 1
End If
If Not fso.FileExists(entry) Then
  MsgBox "找不到 index.mjs: " & entry, 16, "SnowLuma 启动失败"
  WScript.Quit 1
End If

ws.CurrentDirectory = baseDir

' 0 = 隐藏窗口, False = 不等待
cmd = """" & nodeExe & """ """ & entry & """"
ws.Run cmd, 0, False

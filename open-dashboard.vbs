' open-dashboard.vbs — double-click entry point.
' Opens the dashboard if the server is already up on :3000, otherwise starts it first.
' Node is resolved from PATH, falling back to the default install path, so this keeps
' working if Node is not in Program Files (the .bat setup scripts do the same).
Option Explicit

Dim WshShell, oFSO, oExec, result, nodeExe
Set WshShell = CreateObject("WScript.Shell")
Set oFSO = CreateObject("Scripting.FileSystemObject")

Set oExec = WshShell.Exec("cmd /c netstat -ano | findstr "":3000.*LISTENING""")
result = oExec.StdOut.ReadAll()

If Len(Trim(result)) > 0 Then
    ' Already serving — just open a tab.
    WshShell.Run "http://localhost:3000", 1, False
Else
    nodeExe = ResolveNode()
    If nodeExe = "" Then
        MsgBox "Could not find node.exe." & vbCrLf & vbCrLf & _
               "Install Node 18 or later, or add it to your PATH.", 16, "Competitor Price Analyzer"
        WScript.Quit 1
    End If

    WshShell.CurrentDirectory = oFSO.GetParentFolderName(WScript.ScriptFullName)
    ' --no-open: serve.js would otherwise open a second browser window of its own.
    WshShell.Run """" & nodeExe & """ serve.js --no-open", 0, False
    WScript.Sleep 2500
    WshShell.Run "http://localhost:3000", 1, False
End If

' Prefer whatever `where node` finds; fall back to the usual install location.
Function ResolveNode()
    Dim ex, out, lines, i, candidate
    ResolveNode = ""
    On Error Resume Next
    Set ex = WshShell.Exec("cmd /c where node")
    out = ex.StdOut.ReadAll()
    On Error GoTo 0
    If Len(Trim(out)) > 0 Then
        lines = Split(out, vbCrLf)
        For i = 0 To UBound(lines)
            candidate = Trim(lines(i))
            If Len(candidate) > 0 Then
                If oFSO.FileExists(candidate) Then
                    ResolveNode = candidate
                    Exit Function
                End If
            End If
        Next
    End If
    candidate = "C:\Program Files\nodejs\node.exe"
    If oFSO.FileExists(candidate) Then ResolveNode = candidate
End Function

using System;
using System.Runtime.InteropServices;

internal static class ConsoleMode {
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern IntPtr GetStdHandle(int type);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetConsoleMode(IntPtr handle, out uint mode);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool SetConsoleMode(IntPtr handle, uint mode);

    public static int Main(string[] args) {
        IntPtr input = GetStdHandle(-10);
        uint mode;
        if (args.Length == 0 && GetConsoleMode(input, out mode)) {
            Console.WriteLine(mode);
            return 0;
        }
        if (args.Length == 1 && UInt32.TryParse(args[0], out mode) && SetConsoleMode(input, mode)) return 0;
        return 1;
    }
}

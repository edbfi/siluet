using System;
internal static class InterruptPublication {
    public static int Main(string[] args) {
        return FactorKey.Run(new string[] {"publish", args[0]}, delegate(string stage) {
            if (stage == args[1]) Environment.Exit(75);
        });
    }
}

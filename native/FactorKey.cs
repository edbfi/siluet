// Compiled with the .NET Framework compiler shipped with Windows.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

internal static class FactorKey {
    private const int Unsafe = 10, Temporary = 20;
    [StructLayout(LayoutKind.Sequential)]
    private struct FileInfo {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint sharing, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool FlushFileBuffers(SafeFileHandle handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    private static extern bool MoveFileExW(string source, string destination, uint flags);
    [DllImport("advapi32.dll")]
    private static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint requested, out IntPtr owner, IntPtr group, out IntPtr dacl, IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    private static bool Trusted(SecurityIdentifier sid) {
        return sid == WindowsIdentity.GetCurrent().User || sid.IsWellKnown(WellKnownSidType.LocalSystemSid)
            || sid.IsWellKnown(WellKnownSidType.BuiltinAdministratorsSid);
    }
    private static int Verify(SafeFileHandle handle, bool creating, bool directory) {
        FileInfo info;
        if (!GetFileInformationByHandle(handle, out info)) return Temporary;
        if ((info.Attributes & (0x400 | 0x40)) != 0 || ((info.Attributes & 0x10) != 0) != directory) return Unsafe;
        if (!directory && (info.Links != 1 || info.SizeHigh != 0 || info.SizeLow != (creating ? 0 : 32))) return Unsafe;
        IntPtr owner, acl, descriptor;
        if (GetSecurityInfo(handle, 1, 5, out owner, IntPtr.Zero, out acl, IntPtr.Zero, out descriptor) != 0) return Temporary;
        try {
            if (owner == IntPtr.Zero || acl == IntPtr.Zero || !Trusted(new SecurityIdentifier(owner))) return Unsafe;
            byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            RawAcl rules = new RawSecurityDescriptor(bytes, 0).DiscretionaryAcl;
            if (rules == null || rules.Count == 0) return Unsafe;
            foreach (GenericAce ace in rules) {
                QualifiedAce rule = ace as QualifiedAce;
                if (rule == null || (rule.AceQualifier != AceQualifier.AccessDenied && !Trusted(rule.SecurityIdentifier))) return Unsafe;
            }
            return 0;
        } finally { LocalFree(descriptor); }
    }
    private static byte[] Read32(Stream stream) {
        byte[] bytes = new byte[32];
        int count = 0;
        while (count < bytes.Length) {
            int n = stream.Read(bytes, count, bytes.Length - count);
            if (n == 0) throw new EndOfStreamException();
            count += n;
        }
        if (stream.ReadByte() != -1) throw new IOException();
        return bytes;
    }
    public static int Main(string[] args) { return Run(args, delegate(string stage) {}); }

    internal static int Run(string[] args, Action<string> checkpoint) {
        try {
            if (args.Length != 2 || !Path.IsPathRooted(args[1])) return Temporary;
            bool write = args[0] == "publish";
            if (!write && args[0] != "read") return Temporary;
            string path = args[1], temporary = path + ".tmp";
            using (SafeFileHandle parent = CreateFileW(Path.GetDirectoryName(path), 0x20080u, 3u,
                    IntPtr.Zero, 3u, 0x02200000u, IntPtr.Zero)) {
                int parentError = Marshal.GetLastWin32Error();
                if (parent.IsInvalid) return !write && (parentError == 2 || parentError == 3) ? Unsafe : Temporary;
                int parentStatus = Verify(parent, false, true);
                if (parentStatus != 0) return parentStatus;
                return Operate(path, temporary, write, checkpoint);
            }
        } catch { return Temporary; }
    }
    private static int Operate(string path, string temporary, bool write, Action<string> checkpoint) {
        if (write) checkpoint("before-create");
        using (SafeFileHandle handle = CreateFileW(write ? temporary : path,
                (write ? 0x40000000u : 0x80000000u) | 0x20000u, write ? 0u : 1u,
                IntPtr.Zero, write ? 1u : 3u, 0x02200000u, IntPtr.Zero)) {
            int error = Marshal.GetLastWin32Error();
            if (handle.IsInvalid) return !write && (error == 2 || error == 3) ? Unsafe : Temporary;
            int status = Verify(handle, write, false);
            if (status != 0) return status;
            if (write) checkpoint("created");
            using (FileStream stream = new FileStream(handle, write ? FileAccess.Write : FileAccess.Read)) {
                if (write) {
                    byte[] bytes = Read32(Console.OpenStandardInput());
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush();
                    checkpoint("written");
                    if (!FlushFileBuffers(handle)) return Temporary;
                    checkpoint("flushed");
                } else {
                    byte[] bytes = Read32(stream);
                    Console.OpenStandardOutput().Write(bytes, 0, bytes.Length);
                }
            }
        }
        if (write) {
            checkpoint("closed");
            if (!MoveFileExW(temporary, path, 8)) return Temporary;
            checkpoint("published");
        }
        return 0;
    }
}

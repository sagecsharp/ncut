using System;
using System.Runtime.InteropServices;

// ncut-qos.exe high|auto <pid> [<pid> ...]
//
// windows runs the processes of a window that is minimized or covered slower (power throttling: a lower clock and
// the efficiency cores). measured, that makes an export 10 to 20 % slower as soon as the user looks at something
// else, which is exactly what one does during an export. "high" tells windows these processes are doing work the
// user is waiting for, "auto" hands the decision back. a priority class does not do this, only this call does.
//
// the desktop shell (main.cjs) starts it with the process ids of the app itself when an export begins and ends.
// it takes nothing but that word and numbers, prints nothing and shows no window. built by scripts/build-qos.cjs
// with the c# compiler that is part of windows.
static class Program
{
    [StructLayout(LayoutKind.Sequential)]
    struct PowerThrottling
    {
        public uint Version;
        public uint ControlMask;
        public uint StateMask;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetProcessInformation(IntPtr process, int infoClass, ref PowerThrottling info, uint size);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    const uint PROCESS_SET_INFORMATION = 0x0200;
    const int ProcessPowerThrottling = 4;
    const uint EXECUTION_SPEED = 0x1;

    static int Main(string[] args)
    {
        if (args.Length < 2 || args.Length > 65 || (args[0] != "high" && args[0] != "auto")) return 2;
        // high: execution speed throttling is controlled by us and switched off. auto: nothing is controlled by us.
        uint control = args[0] == "high" ? EXECUTION_SPEED : 0;
        int failed = 0;
        for (int i = 1; i < args.Length; i++)
        {
            uint pid;
            if (!uint.TryParse(args[i], out pid) || pid == 0)
            {
                failed++;
                continue;
            }
            IntPtr handle = OpenProcess(PROCESS_SET_INFORMATION, false, pid);
            if (handle == IntPtr.Zero)
            {
                failed++;
                continue;
            }
            PowerThrottling state;
            state.Version = 1;
            state.ControlMask = control;
            state.StateMask = 0;
            if (!SetProcessInformation(handle, ProcessPowerThrottling, ref state, (uint)Marshal.SizeOf(typeof(PowerThrottling)))) failed++;
            CloseHandle(handle);
        }
        return failed == 0 ? 0 : 1;
    }
}

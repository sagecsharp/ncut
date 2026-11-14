using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

// ncut-swap.exe <source> <target> <sha256> <size> start|quiet [<one argument for the new exe>]
//
// the last step of an update of the portable ncut (docs/UPDATE.md). the portable exe is a starter that unpacks the app
// and waits for it, and as long as it runs windows lets nobody rename or replace its file. so the app can not swap its
// own exe: it starts this helper when it closes, and the helper does the swap as soon as the starter has let go.
//
//   1. <source> (the downloaded new exe) must have exactly <size> bytes and the sha256 <sha256>, else nothing happens
//   2. it is copied to <target>.new, and what was written is read back and hashed again
//   3. <target>.new is moved onto <target> in one step (MoveFileEx, replace existing). while the old starter still runs
//      windows refuses that, so it is tried again until the starter has ended, at most two minutes. one step means
//      <target> is always a whole exe: the old one, or the new one
//   4. <source> is deleted
//   5. start: the new <target> is started, with the one argument if there is one
//
// the name the user has for the exe stays (shortcuts and the taskbar pin point at it). it takes nothing but these
// arguments, asks nobody, shows no window, and writes one number to swap.log next to <source> saying how it ended
// (docs/UPDATE.md has the numbers). built by scripts/build-qos.cjs with the c# compiler that is part of windows.
static class Program
{
    const int WaitMs = 120000;
    const int StepMs = 250;
    // the c# compiler of .net framework 4 has no long path support: a path is at most 259 characters. <target>.new has
    // to fit too, so the target is shorter (the app checks the same numbers, updateRules.MAX_SWAP_*)
    const int MaxSourceLength = 259;
    const int MaxTargetLength = 255;

    const uint MoveReplaceExisting = 1;
    const uint MoveWriteThrough = 8;
    const int ErrorAccessDenied = 5;
    const int ErrorSharingViolation = 32;
    const int ErrorLockViolation = 33;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool MoveFileEx(string from, string to, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(IntPtr handle, out HandleInfo info);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    // BY_HANDLE_FILE_INFORMATION, the times as plain numbers
    [StructLayout(LayoutKind.Sequential)]
    struct HandleInfo
    {
        public uint Attributes;
        public uint CreatedLow, CreatedHigh, AccessedLow, AccessedHigh, WrittenLow, WrittenHigh;
        public uint Volume;
        public uint SizeHigh, SizeLow;
        public uint Links;
        public uint IndexHigh, IndexLow;
    }

    static int Main(string[] args)
    {
        string log = null;
        int code = 9;
        try
        {
            if (args.Length < 5 || args.Length > 6) return 2;
            string source = args[0];
            string target = args[1];
            string sha = args[2];
            long size;
            if (!IsExePath(source, MaxSourceLength) || !IsExePath(target, MaxTargetLength)) return 2;
            if (!IsHex64(sha) || !IsSize(args[3], out size)) return 2;
            if (args[4] != "start" && args[4] != "quiet") return 2;
            bool start = args[4] == "start";
            string extra = args.Length == 6 ? args[5] : null;
            if (extra != null && !IsPlainArg(extra)) return 2;
            try
            {
                source = Path.GetFullPath(source);
                target = Path.GetFullPath(target);
            }
            catch
            {
                return 2;
            }
            // the same file under two names (a folder junction, a hard link, a mapped drive) is no download: the swap
            // would end by deleting the new exe it just put in place
            if (string.Equals(source, target, StringComparison.OrdinalIgnoreCase) || SameFile(source, target)) return 2;
            log = Path.Combine(Path.GetDirectoryName(source), "swap.log");

            // one helper per target at a time: a second one would fight over <target>.new
            bool mine;
            using (Mutex mutex = new Mutex(true, "Local\\ncut-swap-" + HashText(target.ToLowerInvariant()), out mine))
            {
                if (!mine)
                {
                    code = 8;
                    return code;
                }
                code = Swap(source, target, sha, size, start, extra);
                mutex.ReleaseMutex();
                return code;
            }
        }
        catch
        {
            return code;
        }
        finally
        {
            Note(log, code);
        }
    }

    static int Swap(string source, string target, string sha, long size, bool start, string extra)
    {
        string fresh = target + ".new";
        if (!IsFile(target)) return 3;
        // 1. the download is what the app said it is
        if (!Matches(source, size, sha)) return 4;
        try
        {
            int code = Replace(source, target, fresh, sha, size);
            if (code != 0) return code;
        }
        finally
        {
            // whatever happened, no half done copy stays next to the exe
            DeleteQuiet(fresh);
        }

        // 4. the download is used up. failing to delete it changes nothing
        DeleteQuiet(source);

        // 5. the new version, started the way the user starts it
        if (start)
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo(target);
                info.UseShellExecute = false;
                info.WorkingDirectory = Path.GetDirectoryName(target);
                if (extra != null) info.Arguments = Quote(extra);
                // what the old starter told the old app is not for the new one (it sets its own)
                info.EnvironmentVariables.Remove("PORTABLE_EXECUTABLE_DIR");
                info.EnvironmentVariables.Remove("PORTABLE_EXECUTABLE_FILE");
                info.EnvironmentVariables.Remove("PORTABLE_EXECUTABLE_APP_FILENAME");
                using (Process p = Process.Start(info)) { }
            }
            catch
            {
                return 1;
            }
        }
        return 0;
    }

    /** steps 2 and 3: the copy next to the exe, then the move onto it. 0 when <target> now is the new exe */
    static int Replace(string source, string target, string fresh, string sha, long size)
    {
        // 2. the copy, read back from the disk
        try
        {
            DeleteQuiet(fresh);
            using (FileStream input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (FileStream output = new FileStream(fresh, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                input.CopyTo(output, 1 << 20);
            }
        }
        catch
        {
            return 5;
        }
        if (!Matches(fresh, size, sha)) return 6;

        // 3. the old starter lets go of its file when it has ended. a read only exe is replaced like any other
        ClearReadOnly(target);
        int error = 0;
        Stopwatch clock = Stopwatch.StartNew();
        for (;;)
        {
            if (MoveFileEx(fresh, target, MoveReplaceExisting | MoveWriteThrough)) return 0;
            error = Marshal.GetLastWin32Error();
            // anything but "in use" (or refused) will not go away by waiting: scanners that hold the fresh copy for a
            // moment and the old starter both end up here
            if (!InUse(error)) return 10;
            if (clock.ElapsedMilliseconds >= WaitMs) return 7;
            Thread.Sleep(StepMs);
        }
    }

    static bool InUse(int error)
    {
        return error == ErrorAccessDenied || error == ErrorSharingViolation || error == ErrorLockViolation;
    }

    /** a full windows path to an exe, with nothing in it that is odd for a path */
    static bool IsExePath(string p, int max)
    {
        if (p == null || p.Length < 4 || p.Length > max) return false;
        if (!p.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return false;
        foreach (char c in p)
        {
            if (c < ' ' || c == '"' || c == '<' || c == '>' || c == '|' || c == '?' || c == '*') return false;
        }
        bool drive = char.IsLetter(p[0]) && p[1] == ':' && (p[2] == '\\' || p[2] == '/');
        bool share = p[0] == '\\' && p[1] == '\\';
        return drive || share;
    }

    static bool IsPlainArg(string a)
    {
        if (a.Length == 0 || a.Length > 1024) return false;
        foreach (char c in a)
        {
            if (c < ' ' || c == '"') return false;
        }
        return true;
    }

    static bool IsHex64(string s)
    {
        if (s == null || s.Length != 64) return false;
        foreach (char c in s)
        {
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
        }
        return true;
    }

    /** only digits (no sign, no spaces, no culture), at least 1 */
    static bool IsSize(string s, out long size)
    {
        size = 0;
        if (s == null || s.Length == 0 || s.Length > 18) return false;
        foreach (char c in s)
        {
            if (c < '0' || c > '9') return false;
        }
        return long.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out size) && size >= 1;
    }

    /** a file, not a folder (a link to a file counts: the move replaces the link itself, never what it points at) */
    static bool IsFile(string p)
    {
        return File.Exists(p);
    }

    /** the file is there, has exactly this size and this sha256. a file that can not be read is not that file */
    static bool Matches(string p, long size, string sha)
    {
        try
        {
            return IsFile(p) && new FileInfo(p).Length == size && HashFile(p) == sha;
        }
        catch
        {
            return false;
        }
    }

    static string HashFile(string p)
    {
        using (SHA256 sha = SHA256.Create())
        using (FileStream f = new FileStream(p, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20))
        {
            return Hex(sha.ComputeHash(f));
        }
    }

    static string HashText(string t)
    {
        using (SHA256 sha = SHA256.Create())
        {
            return Hex(sha.ComputeHash(Encoding.UTF8.GetBytes(t)));
        }
    }

    static string Hex(byte[] bytes)
    {
        StringBuilder s = new StringBuilder(bytes.Length * 2);
        foreach (byte b in bytes) s.Append(b.ToString("x2"));
        return s.ToString();
    }

    /** which file this is on the disk (volume and index) and how many names it has. false when that can not be asked */
    static bool Identity(string p, out uint volume, out ulong index, out uint links)
    {
        volume = 0;
        index = 0;
        links = 0;
        // access 0 and every share flag: only the information is asked, so a file that is in use can still be asked
        IntPtr h = CreateFile(p, 0, 7, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (h == IntPtr.Zero || h == new IntPtr(-1)) return false;
        try
        {
            HandleInfo info;
            if (!GetFileInformationByHandle(h, out info)) return false;
            volume = info.Volume;
            index = ((ulong)info.IndexHigh << 32) | info.IndexLow;
            links = info.Links;
            return true;
        }
        finally
        {
            CloseHandle(h);
        }
    }

    static bool SameFile(string a, string b)
    {
        uint va, vb, la, lb;
        ulong ia, ib;
        if (!Identity(a, out va, out ia, out la) || !Identity(b, out vb, out ib, out lb)) return false;
        return va == vb && ia == ib;
    }

    /** the read only flag (and only it) goes. a file with more than one name is shared with others: not touched */
    static void ClearReadOnly(string p)
    {
        try
        {
            FileAttributes a = File.GetAttributes(p);
            if ((a & FileAttributes.ReadOnly) == 0) return;
            uint volume, links;
            ulong index;
            if (!Identity(p, out volume, out index, out links) || links > 1) return;
            File.SetAttributes(p, a & ~FileAttributes.ReadOnly);
        }
        catch
        {
            /* the caller sees what is left */
        }
    }

    static void DeleteQuiet(string p)
    {
        try
        {
            if (File.Exists(p))
            {
                ClearReadOnly(p);
                File.Delete(p);
            }
        }
        catch
        {
            /* in use or not ours to delete: the caller sees that it is still there */
        }
    }

    /** one argument for a windows command line: in quotes, the backslashes before the closing quote doubled */
    static string Quote(string a)
    {
        int tail = 0;
        while (tail < a.Length && a[a.Length - 1 - tail] == '\\') tail++;
        return "\"" + a + new string('\\', tail) + "\"";
    }

    static void Note(string log, int code)
    {
        if (log == null) return;
        try
        {
            File.WriteAllText(log, code.ToString() + "\n");
        }
        catch
        {
            /* nobody to tell */
        }
    }
}

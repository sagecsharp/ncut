using System;
using System.Diagnostics;
using System.IO;
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
//   3. wait until <target> can be renamed (the old starter has ended), at most two minutes
//   4. <target> becomes <target>.old, <target>.new becomes <target>. if that fails the old file is put back
//   5. <target>.old and <source> are deleted
//   6. start: the new <target> is started, with the one argument if there is one
//
// the name the user has for the exe stays (shortcuts and the taskbar pin point at it), and it never holds half a file.
// it takes nothing but these arguments, asks nobody, shows no window, and writes one line to swap.log next to
// <source> saying how it ended. built by scripts/build-qos.cjs with the c# compiler that is part of windows.
static class Program
{
    const int WaitMs = 120000;
    const int StepMs = 250;

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
            if (!IsExePath(source) || !IsExePath(target)) return 2;
            if (!IsHex64(sha) || !long.TryParse(args[3], out size) || size < 1) return 2;
            if (args[4] != "start" && args[4] != "quiet") return 2;
            bool start = args[4] == "start";
            string extra = args.Length == 6 ? args[5] : null;
            if (extra != null && !IsPlainArg(extra)) return 2;
            if (string.Equals(Path.GetFullPath(source), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase)) return 2;
            log = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(source)), "swap.log");

            // one helper per target at a time: a second one would fight over <target>.new
            bool mine;
            using (Mutex mutex = new Mutex(true, "Local\\ncut-swap-" + HashText(Path.GetFullPath(target).ToLowerInvariant()), out mine))
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
        string old = target + ".old";
        if (!IsPlainFile(target)) return 3;
        // 1. the download is what the app said it is
        if (!IsPlainFile(source) || new FileInfo(source).Length != size || HashFile(source) != sha) return 4;

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
            DeleteQuiet(fresh);
            return 5;
        }
        if (new FileInfo(fresh).Length != size || HashFile(fresh) != sha)
        {
            DeleteQuiet(fresh);
            return 6;
        }

        // 3. + 4. the old starter lets go of its file when it has ended
        bool moved = false;
        Stopwatch clock = Stopwatch.StartNew();
        while (clock.ElapsedMilliseconds < WaitMs)
        {
            try
            {
                DeleteQuiet(old);
                File.Move(target, old);
                moved = true;
                break;
            }
            catch
            {
                Thread.Sleep(StepMs);
            }
        }
        if (!moved)
        {
            DeleteQuiet(fresh);
            return 7;
        }
        try
        {
            File.Move(fresh, target);
        }
        catch
        {
            // the old file goes back under its name, whatever it takes
            for (int i = 0; i < 20; i++)
            {
                try
                {
                    File.Move(old, target);
                    break;
                }
                catch
                {
                    Thread.Sleep(StepMs);
                }
            }
            DeleteQuiet(fresh);
            return 10;
        }

        // 5. tidy up: neither is needed any more, and neither failing changes the result
        for (int i = 0; i < 8 && File.Exists(old); i++)
        {
            DeleteQuiet(old);
            if (File.Exists(old)) Thread.Sleep(StepMs);
        }
        DeleteQuiet(source);

        // 6. the new version, started the way the user starts it
        if (start)
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo(target);
                info.UseShellExecute = false;
                info.WorkingDirectory = Path.GetDirectoryName(Path.GetFullPath(target));
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

    /** a full windows path to an exe, with nothing in it that is odd for a path */
    static bool IsExePath(string p)
    {
        if (p == null || p.Length < 4 || p.Length > 1024) return false;
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

    static bool IsPlainFile(string p)
    {
        try
        {
            FileAttributes a = File.GetAttributes(p);
            return (a & FileAttributes.Directory) == 0 && (a & FileAttributes.ReparsePoint) == 0;
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

    static void DeleteQuiet(string p)
    {
        try
        {
            if (File.Exists(p))
            {
                File.SetAttributes(p, FileAttributes.Normal);
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

param(
    [Parameter(Mandatory = $true)][string]$Manifest,
    [Parameter(Mandatory = $true)][string]$Output
)
$ErrorActionPreference = 'Stop'
# Read-only, aligned device reads. This bypasses the Windows file cache without
# flushing system caches, changing device settings, or writing to source files.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class HyveStorageReadBenchmark {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetFilePointerEx(SafeFileHandle file, long distance, out long position, uint method);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool ReadFile(SafeFileHandle file, IntPtr buffer, uint length, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr VirtualAlloc(IntPtr address, UIntPtr size, uint allocation, uint protection);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool VirtualFree(IntPtr address, UIntPtr size, uint type);
    public sealed class Result {
        public string File;
        public int BlockBytes, Count, Repetition;
        public bool Sequential;
        public long[] Offsets;
        public double[] Milliseconds;
        public double ElapsedMs;
        public long Checksum;
    }
    public static Result Run(string path, int blockBytes, int count, bool sequential, int repetition) {
        long length = new FileInfo(path).Length;
        var result = new Result { File=Path.GetFileName(path), BlockBytes=blockBytes, Count=count,
            Sequential=sequential, Repetition=repetition, Offsets=new long[count], Milliseconds=new double[count] };
        IntPtr buffer = VirtualAlloc(IntPtr.Zero, (UIntPtr)blockBytes, 0x3000, 4);
        if (buffer == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            using (var file = CreateFileW(path, 0x80000000, 7, IntPtr.Zero, 3, 0x20000000, IntPtr.Zero)) {
                if (file.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                uint seed = (uint)(0x4a534f4e + repetition * 97 + blockBytes);
                long slots = (length - blockBytes) / 4096;
                long start = (16L + repetition * 288L) * 1024 * 1024;
                var elapsed = Stopwatch.StartNew();
                for (int i=0; i<count; i++) {
                    seed = unchecked(seed * 1664525 + 1013904223);
                    long offset = sequential ? start + (long)i * blockBytes : (long)((ulong)seed * (ulong)slots / 4294967296UL) * 4096;
                    if (offset + blockBytes > length) throw new InvalidOperationException("Read outside file");
                    long position; uint read;
                    var timer = Stopwatch.StartNew();
                    if (!SetFilePointerEx(file, offset, out position, 0) || !ReadFile(file, buffer, (uint)blockBytes, out read, IntPtr.Zero))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    timer.Stop();
                    if (read != blockBytes) throw new EndOfStreamException();
                    result.Offsets[i] = offset;
                    result.Milliseconds[i] = timer.Elapsed.TotalMilliseconds;
                    result.Checksum += Marshal.ReadByte(buffer) + Marshal.ReadByte(buffer, blockBytes-1);
                }
                result.ElapsedMs = elapsed.Elapsed.TotalMilliseconds;
            }
        } finally { VirtualFree(buffer, UIntPtr.Zero, 0x8000); }
        return result;
    }
}
'@
$inputs = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$results = @()
foreach ($kind in @('fp32Data', 'color')) {
    foreach ($device in $inputs) {
        $sourcePath = (Resolve-Path -LiteralPath $device.$kind).Path
        foreach ($repetition in 0..1) {
            foreach ($work in @(@{ Bytes=65536; Count=128; Sequential=$false }, @{ Bytes=1048576; Count=32; Sequential=$false }, @{ Bytes=4194304; Count=64; Sequential=$true })) {
                Write-Host "Read-only device benchmark: $($device.label) $kind block=$($work.Bytes) repeat=$repetition"
                $row = [HyveStorageReadBenchmark]::Run($sourcePath, $work.Bytes, $work.Count, $work.Sequential, $repetition)
                $results += [pscustomobject]@{ Device=$device.label; Kind=$kind; Result=$row }
            }
        }
    }
}
$drives = foreach ($letter in @('E','D')) {
    $disk = Get-Partition -DriveLetter $letter | Get-Disk
    [pscustomobject]@{ Drive=$letter; Model=$disk.FriendlyName; Bus=$disk.BusType.ToString(); Bytes=$disk.Size; LogicalSectorBytes=$disk.LogicalSectorSize; PhysicalSectorBytes=$disk.PhysicalSectorSize }
}
$report = [pscustomobject]@{
    Timestamp=[DateTime]::UtcNow.ToString('o'); Method='CreateFileW GENERIC_READ + FILE_FLAG_NO_BUFFERING; QD1; 4096-aligned offsets; VirtualAlloc-aligned buffers; no source writes'
    Caveat='Windows file cache bypassed; device/controller cache and other system activity are uncontrolled.'
    CPU=(Get-CimInstance Win32_Processor | Select-Object -ExpandProperty Name)
    Memory=(Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory)
    Drives=@($drives); Results=$results
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Output -Encoding utf8
Write-Host "Report: $Output"

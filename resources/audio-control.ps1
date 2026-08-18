$ErrorActionPreference = 'Stop'

# Endpoint-volume access stays in this process so the exact device and level
# changed at dictation start can be restored at dictation end.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class WhispEndpointVolume
{
    private enum EDataFlow { Render, Capture, All }
    private enum ERole { Console, Multimedia, Communications }

    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumeratorComObject { }

    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, uint stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig]
        int Activate(ref Guid iid, uint classContext, IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        [PreserveSig] int OpenPropertyStore(uint access, out IntPtr properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out uint state);
    }

    [ComImport]
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int GetChannelCount(out uint count);
        [PreserveSig] int SetMasterVolumeLevel(float levelDb, ref Guid eventContext);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
        [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDb, ref Guid eventContext);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid eventContext);
        [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDb);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool muted, ref Guid eventContext);
        [PreserveSig] int GetMute(out bool muted);
        [PreserveSig] int GetVolumeStepInfo(out uint step, out uint stepCount);
        [PreserveSig] int VolumeStepUp(ref Guid eventContext);
        [PreserveSig] int VolumeStepDown(ref Guid eventContext);
        [PreserveSig] int QueryHardwareSupport(out uint mask);
        [PreserveSig] int GetVolumeRange(out float minDb, out float maxDb, out float incrementDb);
    }

    private static IAudioEndpointVolume endpoint;
    private static readonly Guid eventContext = new Guid("48B4BEB7-DB5B-49F1-B258-BE4D25AF460A");
    private static float originalLevel;
    private static float loweredLevel;
    private static bool active;

    private static void Check(int result)
    {
        if (result < 0) Marshal.ThrowExceptionForHR(result);
    }

    private static void ReleaseCom(object value)
    {
        if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
    }

    private static void ReleaseEndpoint()
    {
        ReleaseCom(endpoint);
        endpoint = null;
        active = false;
    }

    public static void Lower(float factor)
    {
        if (active) return;

        IMMDeviceEnumerator enumerator = null;
        IMMDevice device = null;
        try
        {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            Check(enumerator.GetDefaultAudioEndpoint(EDataFlow.Render, ERole.Console, out device));

            Guid endpointVolumeId = typeof(IAudioEndpointVolume).GUID;
            object activated;
            Check(device.Activate(ref endpointVolumeId, 23, IntPtr.Zero, out activated));
            endpoint = (IAudioEndpointVolume)activated;

            Check(endpoint.GetMasterVolumeLevelScalar(out originalLevel));
            loweredLevel = Math.Max(0.0f, Math.Min(1.0f, originalLevel * factor));
            Guid context = eventContext;
            Check(endpoint.SetMasterVolumeLevelScalar(loweredLevel, ref context));
            active = true;
        }
        catch
        {
            ReleaseEndpoint();
            throw;
        }
        finally
        {
            ReleaseCom(device);
            ReleaseCom(enumerator);
        }
    }

    public static void Restore()
    {
        if (!active || endpoint == null) return;
        try
        {
            float currentLevel;
            Check(endpoint.GetMasterVolumeLevelScalar(out currentLevel));
            // A different current value means the human changed volume while
            // dictating. Their newer choice wins; do not overwrite it.
            if (Math.Abs(currentLevel - loweredLevel) <= 0.005f)
            {
                Guid context = eventContext;
                Check(endpoint.SetMasterVolumeLevelScalar(originalLevel, ref context));
            }
        }
        finally
        {
            ReleaseEndpoint();
        }
    }
}
'@

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$asTaskMethod = @(
    [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
    }
)[0]

$mediaManager = $null
$pausedSessions = New-Object System.Collections.ArrayList

function Wait-WinRtOperation($operation, [Type]$resultType) {
    $method = $asTaskMethod.MakeGenericMethod($resultType)
    $task = $method.Invoke($null, @($operation))
    return $task.GetAwaiter().GetResult()
}

function Get-MediaManager {
    if ($null -eq $script:mediaManager) {
        $operation = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
        $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
        $script:mediaManager = Wait-WinRtOperation $operation $managerType
    }
    return $script:mediaManager
}

function Pause-Media {
    if ($pausedSessions.Count -gt 0) { return }
    $manager = Get-MediaManager
    foreach ($session in $manager.GetSessions()) {
        try {
            if ($session.GetPlaybackInfo().PlaybackStatus.ToString() -ne 'Playing') { continue }
            $paused = Wait-WinRtOperation ($session.TryPauseAsync()) ([bool])
            if ($paused) { [void]$pausedSessions.Add($session) }
        } catch {
            # One media application refusing control must not block the rest.
        }
    }
}

function Resume-Media {
    foreach ($session in @($pausedSessions)) {
        try {
            if ($session.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Paused') {
                [void](Wait-WinRtOperation ($session.TryPlayAsync()) ([bool]))
            }
        } catch {
            # Closed or replaced media sessions need no restoration.
        }
    }
    $pausedSessions.Clear()
}

function Restore-Audio {
    Resume-Media
    [WhispEndpointVolume]::Restore()
}

$quit = $false
try {
    while (!$quit -and ($line = [Console]::In.ReadLine()) -ne $null) {
        try {
            $message = $line | ConvertFrom-Json
            switch ($message.action) {
                'lower' {
                    Restore-Audio
                    [WhispEndpointVolume]::Lower(0.15)
                }
                'pause' {
                    Restore-Audio
                    Pause-Media
                }
                'restore' { Restore-Audio }
                'quit' {
                    Restore-Audio
                    $quit = $true
                }
                default { throw "Unknown audio-control action: $($message.action)" }
            }
            [Console]::Out.WriteLine('{"ok":true}')
        } catch {
            $response = @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
            [Console]::Out.WriteLine($response)
        }
        [Console]::Out.Flush()
    }
} finally {
    Restore-Audio
}

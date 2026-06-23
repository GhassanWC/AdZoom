using System.Net.Http.Headers;
using ExportApi.Models;
using Google.Apis.Auth.OAuth2;
using Google.Cloud.Storage.V1;
using GcsObject = Google.Apis.Storage.v1.Data.Object;

namespace ExportApi.Services;

/// <summary>Download the source from / upload the MP4 to Firebase Storage (a GCS bucket).</summary>
public sealed class StorageService(StorageClient client, ExportOptions opts, ILogger<StorageService> log)
{
    private string Bucket => opts.StorageBucket
        ?? throw new InvalidOperationException("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set.");

    /// <summary>A contentType the HTTP stack can't parse as a single media type —
    /// e.g. "video/mp4;codecs=avc1.42e01e,mp4a.40.2" (MediaRecorder mimeType). The
    /// comma/params make the typed download throw FormatException.</summary>
    private static bool IsUnsafeContentType(string? ct) =>
        !string.IsNullOrEmpty(ct) && (ct.Contains(';') || ct.Contains(','));

    public async Task DownloadAsync(string objectPath, string destFile, CancellationToken ct)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destFile)!);

        // Some source videos were stored with a codecs-bearing contentType
        // (e.g. "video/mp4;codecs=avc1.42e01e,mp4a.40.2"). The comma makes the
        // download's Content-Type response header unparseable → FormatException.
        // HEAL it: read the metadata and, if unsafe, PATCH the object to a bare
        // "video/mp4" before downloading (also fixes future browser playback).
        try
        {
            var obj = await client.GetObjectAsync(Bucket, objectPath, cancellationToken: ct);
            log.LogInformation("[export:storage-content-type] object={Object} contentType={ContentType}",
                objectPath, obj.ContentType ?? "(none)");
            if (IsUnsafeContentType(obj.ContentType))
            {
                await client.PatchObjectAsync(
                    new GcsObject { Bucket = Bucket, Name = objectPath, ContentType = "video/mp4" },
                    cancellationToken: ct);
                log.LogWarning("[export:storage-content-type] sanitized object={Object} from={From} to=video/mp4",
                    objectPath, obj.ContentType);
            }
        }
        catch (Exception ex)
        {
            // Non-fatal — the FormatException fallback below still covers download.
            log.LogWarning("[export:storage-content-type] metadata check/patch failed object={Object} err={Err}",
                objectPath, ex.Message);
        }

        try
        {
            await using var fs = File.Create(destFile);
            await client.DownloadObjectAsync(Bucket, objectPath, fs, cancellationToken: ct);
        }
        catch (FormatException ex)
        {
            // The stored contentType is still unparseable (e.g. the patch lacked
            // permission). Fall back to a raw authenticated media download that
            // never parses the Content-Type header.
            log.LogWarning("[export:storage-content-type] typed download hit FormatException — raw fallback object={Object} err={Err}",
                objectPath, ex.Message);
            await RawDownloadAsync(objectPath, destFile, ct);
        }
    }

    /// <summary>Authenticated GET of the media bytes via the JSON API (alt=media),
    /// streaming straight to disk WITHOUT touching the response Content-Type — so a
    /// malformed stored contentType can't throw.</summary>
    private async Task RawDownloadAsync(string objectPath, string destFile, CancellationToken ct)
    {
        var credential = await GoogleCredential.GetApplicationDefaultAsync(ct);
        if (credential.IsCreateScopedRequired)
            credential = credential.CreateScoped("https://www.googleapis.com/auth/devstorage.read_only");
        // GetAccessTokenForRequestAsync lives on ITokenAccess, not GoogleCredential.
        var tokenAccess = (ITokenAccess)credential.UnderlyingCredential;
        var accessToken = await tokenAccess.GetAccessTokenForRequestAsync(cancellationToken: ct);

        var url = $"https://storage.googleapis.com/storage/v1/b/{Bucket}/o/{Uri.EscapeDataString(objectPath)}?alt=media";
        using var http = new HttpClient();
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        resp.EnsureSuccessStatusCode();
        await using var outFs = File.Create(destFile);
        await using var inStream = await resp.Content.ReadAsStreamAsync(ct);
        await inStream.CopyToAsync(outFs, ct);
        log.LogInformation("[export:storage-content-type] raw fallback download ok object={Object}", objectPath);
    }

    /// <summary>Upload the MP4 (always bare "video/mp4") with a Firebase download token; return the URL.</summary>
    public async Task<string> UploadMp4Async(string sourceFile, string objectPath, CancellationToken ct)
    {
        var token = Guid.NewGuid().ToString();
        const string contentType = "video/mp4"; // never include codecs
        log.LogInformation("[export:storage-content-type] object={Object} contentType={ContentType} (upload)", objectPath, contentType);
        var destination = new GcsObject
        {
            Bucket = Bucket,
            Name = objectPath,
            ContentType = contentType,
            Metadata = new Dictionary<string, string> { ["firebaseStorageDownloadTokens"] = token },
        };
        await using (var fs = File.OpenRead(sourceFile))
        {
            await client.UploadObjectAsync(destination, fs, options: null, cancellationToken: ct);
        }
        var encoded = Uri.EscapeDataString(objectPath);
        return $"https://firebasestorage.googleapis.com/v0/b/{Bucket}/o/{encoded}?alt=media&token={token}";
    }

    /// <summary>Best-effort delete of an object (e.g. an intermediate chunk MP4 after
    /// a successful merge). Swallows NotFound + any error — cleanup must never fail
    /// the export.</summary>
    public async Task DeleteAsync(string objectPath, CancellationToken ct)
    {
        try
        {
            await client.DeleteObjectAsync(Bucket, objectPath, options: null, cancellationToken: ct);
        }
        catch (Exception ex)
        {
            log.LogWarning("[export:storage-delete] best-effort delete failed object={Object} err={Err}",
                objectPath, ex.Message);
        }
    }
}

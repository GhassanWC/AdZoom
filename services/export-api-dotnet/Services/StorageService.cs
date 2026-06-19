using ExportApi.Models;
using Google.Cloud.Storage.V1;
using GcsObject = Google.Apis.Storage.v1.Data.Object;

namespace ExportApi.Services;

/// <summary>Download the source from / upload the MP4 to Firebase Storage (a GCS bucket).</summary>
public sealed class StorageService(StorageClient client, ExportOptions opts)
{
    private string Bucket => opts.StorageBucket
        ?? throw new InvalidOperationException("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set.");

    public async Task DownloadAsync(string objectPath, string destFile, CancellationToken ct)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destFile)!);
        await using var fs = File.Create(destFile);
        await client.DownloadObjectAsync(Bucket, objectPath, fs, cancellationToken: ct);
    }

    /// <summary>Upload the MP4 with a Firebase download token; return the public download URL.</summary>
    public async Task<string> UploadMp4Async(string sourceFile, string objectPath, CancellationToken ct)
    {
        var token = Guid.NewGuid().ToString();
        var destination = new GcsObject
        {
            Bucket = Bucket,
            Name = objectPath,
            ContentType = "video/mp4",
            Metadata = new Dictionary<string, string> { ["firebaseStorageDownloadTokens"] = token },
        };
        await using (var fs = File.OpenRead(sourceFile))
        {
            await client.UploadObjectAsync(destination, fs, options: null, cancellationToken: ct);
        }
        var encoded = Uri.EscapeDataString(objectPath);
        return $"https://firebasestorage.googleapis.com/v0/b/{Bucket}/o/{encoded}?alt=media&token={token}";
    }
}

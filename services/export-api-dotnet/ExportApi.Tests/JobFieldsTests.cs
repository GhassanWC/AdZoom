using ExportApi.Models;
using Xunit;

namespace ExportApi.Tests;

/// <summary>
/// Guards the deterministic-error classification that drives the cost-safety fail-fast:
/// a deterministic code skips in-process retries and exits <see cref="ExitCodes.Fatal"/>
/// so Batch's lifecycle policy FAIL_TASKs it without a retry VM. A transient code keeps
/// the normal one retry. Keep this in sync with the Node CLI's errors.ts codes.
/// </summary>
public class JobFieldsTests
{
    [Theory]
    [InlineData("unsupported_video")]
    [InlineData("decode_failed")]
    [InlineData("audio_decode_failed")]
    [InlineData("normalize_not_executed")]
    [InlineData("normalize_failed")]
    [InlineData("chunk_unsupported_effects")]
    [InlineData("bad_invocation")]
    public void IsDeterministicError_true_for_input_and_setup_codes(string code)
    {
        Assert.True(JobFields.IsDeterministicError(code));
    }

    [Theory]
    [InlineData("render_failed")]
    [InlineData("upload_failed")]
    [InlineData("worker_error")]
    [InlineData("merge_failed")]
    [InlineData("audio_missing_after_render")]
    [InlineData("encoder_pipe_broken")]
    public void IsDeterministicError_false_for_transient_codes(string code)
    {
        Assert.False(JobFields.IsDeterministicError(code));
    }

    [Fact]
    public void IsDeterministicError_false_for_null_and_unknown()
    {
        Assert.False(JobFields.IsDeterministicError(null));
        Assert.False(JobFields.IsDeterministicError("something_new"));
    }

    [Fact]
    public void IsDeterministicError_is_case_insensitive()
    {
        Assert.True(JobFields.IsDeterministicError("UNSUPPORTED_VIDEO"));
    }

    [Fact]
    public void FatalExitCode_is_42_matching_the_batch_lifecycle_contract()
    {
        // Must stay in sync with FATAL_EXIT_CODE in src/lib/export/batch-backend.ts.
        Assert.Equal(42, ExitCodes.Fatal);
    }
}

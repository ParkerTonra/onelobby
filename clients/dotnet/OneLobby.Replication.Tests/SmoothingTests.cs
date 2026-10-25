using Xunit;

namespace OneLobby.Replication.Tests
{
    public class SmoothingTests
    {
        [Fact]
        public void SmallCorrectionGlidesToZeroLinearly()
        {
            var s = new PredictionSmoother();                     // 100 ms, 2.0 / 0.5
            Assert.False(s.Correct(1f, 0.2f, 0f));
            Assert.Equal((-1f, -0.2f, 0f), s.Offset);             // shown position stays where it was
            s.Update(50);
            Assert.Equal(-0.5f, s.Offset.X, 4);
            Assert.Equal(-0.1f, s.Offset.Y, 4);
            s.Update(60);
            Assert.Equal((0f, 0f, 0f), s.Offset);
            Assert.Equal(0, s.SnapCount);
        }

        [Fact]
        public void CorrectionMidDecayAddsToWhatIsLeft()
        {
            var s = new PredictionSmoother();
            s.Correct(1f, 0f, 0f);
            s.Update(50);                                        // -0.5 left
            s.Correct(0f, 0f, 1f);
            Assert.Equal(-0.5f, s.Offset.X, 4);
            Assert.Equal(-1f, s.Offset.Z, 4);
            s.Update(100);
            Assert.Equal(0f, s.OffsetRemaining);
        }

        [Fact]
        public void LargeCorrectionsSnap()
        {
            var s = new PredictionSmoother();
            Assert.True(s.Correct(1.5f, 0f, 1.5f));               // 2.12 on the plane
            Assert.Equal(0f, s.OffsetRemaining);
            Assert.True(s.Correct(0f, 0.6f, 0f));                 // vertical
            Assert.Equal(2, s.SnapCount);
            Assert.False(s.Correct(0f, 0.4f, 1.9f));
        }

        [Fact]
        public void ChangedSequenceSnapsWhateverTheDistance()
        {
            var s = new PredictionSmoother();
            Assert.False(s.Correct(0.1f, 0f, 0f, sequence: 3));   // first sight only records it
            Assert.False(s.Correct(0.1f, 0f, 0f, sequence: 3));
            Assert.True(s.Correct(0.1f, 0f, 0f, sequence: 4));
            Assert.Equal(0f, s.OffsetRemaining);
            Assert.Equal(1, s.SnapCount);
        }

        [Fact]
        public void LerpOrSnapJumpsPastMaxDistance()
        {
            Assert.Equal(1f, NetMath.LerpOrSnap(0f, 2f, 0.5f, 2.5f));
            Assert.Equal(10f, NetMath.LerpOrSnap(0f, 10f, 0.5f, 2f));
            Assert.Equal((0.5f, 0f, 0.5f), NetMath.LerpOrSnap((0f, 0f, 0f), (1f, 0f, 1f), 0.5f, 2f));
            Assert.Equal((100f, 0f, 0f), NetMath.LerpOrSnap((0f, 0f, 0f), (100f, 0f, 0f), 0.5f, 2f));
        }
    }
}

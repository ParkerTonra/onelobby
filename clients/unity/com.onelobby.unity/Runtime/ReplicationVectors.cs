using OneLobby.Replication;
using UnityEngine;

namespace OneLobby.Unity
{
    /// <summary>
    /// <see cref="Vector3"/> versions of the replication helpers that take (X, Y, Z) tuples, so a game needs no converter.
    /// Y is up, as in <see cref="PredictionSmoother"/>.
    /// </summary>
    public static class ReplicationVectors
    {
        public static Vector3 ToVector3(this (float X, float Y, float Z) v) => new Vector3(v.X, v.Y, v.Z);

        public static (float X, float Y, float Z) ToTuple(this Vector3 v) => (v.x, v.y, v.z);

        /// <summary><see cref="PredictionSmoother.Offset"/> as a <see cref="Vector3"/>: add it to the drawn position.</summary>
        public static Vector3 OffsetVector(this PredictionSmoother smoother) => smoother.Offset.ToVector3();

        /// <inheritdoc cref="PredictionSmoother.Correct(float, float, float, int?)"/>
        public static bool Correct(this PredictionSmoother smoother, Vector3 error, int? sequence = null) =>
            smoother.Correct(error.x, error.y, error.z, sequence);

        /// <summary><see cref="NetMath.LerpOrSnap(float, float, float, float)"/> for positions: lerp, or jump to b when it is more than maxDistance away.</summary>
        public static Vector3 LerpOrSnap(Vector3 a, Vector3 b, float t, float maxDistance) =>
            NetMath.LerpOrSnap(a.ToTuple(), b.ToTuple(), t, maxDistance).ToVector3();
    }
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getFileUrl } from "@/lib/storage";

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
): Promise<NextResponse> {
  const { userId } = await params;

  if (!userId || !userId.trim()) {
    return errorResponse("A userId is required.", 400);
  }

  const video = await db.video.findUnique({ where: { userId } });

  if (!video) {
    return errorResponse("No video found for this user.", 404);
  }

  if (video.status === "processing") {
    return NextResponse.json({ status: "processing" }, { status: 200 });
  }

  if (video.status === "failed") {
    return NextResponse.json(
      { status: "failed", errorMessage: video.errorMessage },
      { status: 200 }
    );
  }

  if (video.status !== "ready" || !video.videoKey) {
    return errorResponse("Video is not available.", 500);
  }

  try {
    const signedUrl = await getFileUrl(video.videoKey);
    return NextResponse.redirect(signedUrl);
  } catch (error) {
    return errorResponse(
      `Failed to generate playback URL: ${(error as Error).message}`,
      500
    );
  }
}
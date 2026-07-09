import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import { NextRequest, NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getFilePath } from "@/lib/storage";

export const runtime = "nodejs";

type RouteContext = {
	params: Promise<{ userId: string }>;
};

function jsonError(message: string, status: number): NextResponse {
	return NextResponse.json({ error: message }, { status });
}

function parseRange(rangeHeader: string, fileSize: number): { start: number; end: number } | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
	if (!match) {
		return null;
	}

	const startText = match[1];
	const endText = match[2];

	if (!startText && !endText) {
		return null;
	}

	if (!startText && endText) {
		const suffixLength = Number.parseInt(endText, 10);
		if (Number.isNaN(suffixLength) || suffixLength <= 0) {
			return null;
		}

		const start = Math.max(fileSize - suffixLength, 0);
		return { start, end: fileSize - 1 };
	}

	const start = Number.parseInt(startText, 10);
	if (Number.isNaN(start) || start < 0 || start >= fileSize) {
		return null;
	}

	if (!endText) {
		return { start, end: fileSize - 1 };
	}

	const end = Number.parseInt(endText, 10);
	if (Number.isNaN(end) || end < start) {
		return null;
	}

	return { start, end: Math.min(end, fileSize - 1) };
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
	try {
		const { userId } = await context.params;

		const video = await db.video.findUnique({
			where: { userId },
			select: { filePath: true },
		});

		if (!video) {
			return jsonError("Video not found.", 404);
		}

		const absolutePath = getFilePath(userId, video.filePath);
		const fileStats = await stat(absolutePath);
		const fileSize = fileStats.size;

		const rangeHeader = request.headers.get("range");
		if (!rangeHeader) {
			const stream = createReadStream(absolutePath);
			return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
				status: 200,
				headers: {
					"Content-Type": "video/mp4",
					"Content-Length": String(fileSize),
					"Accept-Ranges": "bytes",
					"Cache-Control": "no-store",
				},
			});
		}

		const parsedRange = parseRange(rangeHeader, fileSize);
		if (!parsedRange) {
			return new NextResponse(null, {
				status: 416,
				headers: {
					"Content-Range": `bytes */${fileSize}`,
					"Accept-Ranges": "bytes",
				},
			});
		}

		const { start, end } = parsedRange;
		const chunkSize = end - start + 1;
		const stream = createReadStream(absolutePath, { start, end });

		return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
			status: 206,
			headers: {
				"Content-Type": "video/mp4",
				"Content-Length": String(chunkSize),
				"Content-Range": `bytes ${start}-${end}/${fileSize}`,
				"Accept-Ranges": "bytes",
				"Cache-Control": "no-store",
			},
		});
	} catch (error) {
		console.error("Video stream error:", error);
		return jsonError("Failed to stream video.", 500);
	}
}

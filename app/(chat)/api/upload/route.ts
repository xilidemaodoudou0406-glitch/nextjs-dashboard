// app/(chat)/api/upload/route.ts
import { NextResponse } from 'next/server';
import { writeFile } from 'fs/promises';
import { join } from 'path';

// 接收文件，存到本地，返回url
export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get('file') as File;

  if (!file) {
    return NextResponse.json({ error: 'No file' }, { status: 400 });
  }

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  // 存到 public/uploads 目录
  const uploadDir = join(process.cwd(), 'public', 'uploads');
  // 注意：实际项目中需要确保 uploads 目录存在，这里简化处理
  // 在原始文件名前加上时间戳，防止两个用户上传同名文件时互相覆盖
  const fileName = `${Date.now()}-${file.name}`;
  const filePath = join(uploadDir, fileName);
  
  await writeFile(filePath, buffer);

  // 返回可访问的 URL
  const url = `/uploads/${fileName}`;
  return NextResponse.json({ url });
}
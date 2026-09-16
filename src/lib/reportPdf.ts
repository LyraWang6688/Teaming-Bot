'use client';

import { toJpeg } from 'html-to-image';
import { jsPDF } from 'jspdf';

export async function buildReportPdf(reportRoot: HTMLElement, customTitle?: string) {
  await document.fonts.ready;
  const pages = Array.from(reportRoot.querySelectorAll<HTMLElement>('[data-pdf-page]'));
  if (!pages.length) throw new Error('没有找到可导出的报告页面');

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pageWidth = 210;
  const pageHeight = 297;
  const margin = 7;

  for (let index = 0; index < pages.length; index += 1) {
    if (index > 0) pdf.addPage('a4', 'portrait');
    const dataUrl = await toJpeg(pages[index], {
      quality: 0.92,
      pixelRatio: 1.5,
      cacheBust: true,
      fontEmbedCSS: '',
      backgroundColor: '#ffffff',
    });
    const image = await loadImage(dataUrl);
    const maxWidth = pageWidth - margin * 2;
    const maxHeight = pageHeight - margin * 2;
    const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    pdf.addImage(dataUrl, 'JPEG', (pageWidth - width) / 2, (pageHeight - height) / 2, width, height, undefined, 'FAST');
  }

  return {
    blob: pdf.output('blob'),
    filename: reportPdfFilename(customTitle),
  };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reportPdfFilename(customTitle?: string) {
  const baseName = (customTitle || '会议分析报告')
    .replace(/\.(txt|docx|json)$/i, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '_');
  return `${baseName}-团队学习状态评估与建议报告.pdf`;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('报告图片生成失败'));
    image.src = src;
  });
}

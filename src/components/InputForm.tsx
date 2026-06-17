'use client';

import React, { useState, useRef } from 'react';
import { Upload, Files, X, Play, FileText } from 'lucide-react';

interface InputFormProps {
  onAnalyzeFiles: (files: File[]) => void;
  isLoading: boolean;
}

const InputForm: React.FC<InputFormProps> = ({ onAnalyzeFiles, isLoading }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const newFiles = Array.from(e.target.files) as File[];
      addFiles(newFiles);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const addFiles = (files: File[]) => {
    const validFiles = files.filter(file =>
      file.type === 'text/plain' ||
      file.name.endsWith('.txt') ||
      file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      file.name.endsWith('.docx')
    );
    if (validFiles.length > 0) {
      setPendingFiles(prev => {
        const existingNames = new Set(prev.map(f => f.name));
        const deduped = validFiles.filter(f => !existingNames.has(f.name));
        return [...prev, ...deduped];
      });
    }
  };

  const removeFile = (index: number) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleStartAnalysis = () => {
    if (pendingFiles.length > 0) {
      onAnalyzeFiles(pendingFiles);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const droppedFiles = Array.from(e.dataTransfer.files) as File[];
      addFiles(droppedFiles);
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      <div className="text-center mb-10">
        <h2 className="text-3xl md:text-4xl font-bold text-slate-900 mb-4">Teaming视角下的会议动力分析</h2>
        <p className="text-lg text-slate-600 max-w-2xl mx-auto">
          上传 Text 文件，Teaming Bot 将基于 Amy Edmondson 的框架批量分析会议纪要。
        </p>
      </div>

      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-2">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileUpload}
          className="hidden"
          accept=".txt,.docx"
          multiple
        />
        <div
          className="relative min-h-[200px] flex flex-col"
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div
            className={`flex-grow flex flex-col items-center justify-center border-2 border-dashed rounded-xl m-4 cursor-pointer transition-all ${
              isDragging
                ? 'border-indigo-500 bg-indigo-50'
                : 'border-slate-200 hover:bg-slate-50'
            }`}
            onClick={() => fileInputRef.current?.click()}
          >
            <Files className={`w-12 h-12 mb-3 transition-colors ${isDragging ? 'text-indigo-500' : 'text-slate-300'}`} />
            <p className={`font-medium transition-colors ${isDragging ? 'text-indigo-700' : 'text-slate-500'}`}>
              {isDragging ? '松开鼠标以上传' : '点击选择或拖拽文件到这里'}
            </p>
            <p className="text-xs text-slate-400 mt-1">支持 .txt 或 .docx 格式，可多次添加</p>
          </div>
        </div>

        {/* 已添加的文件列表 */}
        {pendingFiles.length > 0 && (
          <div className="border-t border-slate-100 px-4 py-3">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
              已添加 {pendingFiles.length} 个文件
            </p>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {pendingFiles.map((file, index) => (
                <div key={`${file.name}-${index}`} className="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2">
                  <div className="flex items-center space-x-2 min-w-0">
                    <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
                    <span className="text-sm text-slate-700 truncate">{file.name}</span>
                    <span className="text-xs text-slate-400 flex-shrink-0">
                      {(file.size / 1024).toFixed(1)} KB
                    </span>
                  </div>
                  <button
                    onClick={() => removeFile(index)}
                    className="text-slate-400 hover:text-red-500 transition-colors flex-shrink-0 ml-2"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 底部操作栏 */}
        <div className="border-t border-slate-100 p-4 bg-slate-50 rounded-b-xl flex justify-center items-center gap-3">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center space-x-2 px-6 py-2 rounded-lg text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 transition-all font-semibold"
          >
            <Upload className="w-4 h-4" />
            <span>继续添加</span>
          </button>

          <button
            type="button"
            onClick={handleStartAnalysis}
            disabled={pendingFiles.length === 0 || isLoading}
            className="flex items-center space-x-2 px-6 py-2 rounded-lg text-white bg-indigo-600 hover:bg-indigo-700 shadow-md hover:shadow-lg transition-all font-semibold disabled:bg-slate-300 disabled:cursor-not-allowed disabled:shadow-none"
          >
            <Play className="w-4 h-4" />
            <span>开始分析 ({pendingFiles.length})</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default InputForm;

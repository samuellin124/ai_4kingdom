'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/app/contexts/AuthContext';
import styles from './page.module.css';
import type { AiToolRecord, AiToolStatus } from '@/app/types/aiTools';

interface FormState {
  id?: string;
  name: string;
  shortTitle: string;
  description: string;
  category: string;
  subcategory: string;
  iconUrl: string;
  websiteUrl: string;
  displayOrder: string;
  status: AiToolStatus;
  featured: boolean;
}

const emptyForm: FormState = {
  name: '',
  shortTitle: '',
  description: '',
  category: '',
  subcategory: '',
  iconUrl: '',
  websiteUrl: '',
  displayOrder: '0',
  status: 'active',
  featured: false,
};

interface AdminResponse {
  success: boolean;
  error?: string;
  items?: AiToolRecord[];
  item?: AiToolRecord;
  iconUrl?: string;
}

function statusLabel(status: AiToolStatus) {
  return status === 'active' ? '启用' : '停用';
}

export default function AdminAiToolsPage() {
  const { user, loading: authLoading } = useAuth();
  const [tools, setTools] = useState<AiToolRecord[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const requestHeaders = useMemo(
    () => ({
      'Content-Type': 'application/json',
      'x-user-id': user?.user_id || '',
    }),
    [user?.user_id]
  );

  const loadTools = async () => {
    if (!user?.user_id) return;
    setLoading(true);
    setMessage(null);

    try {
      const response = await fetch(`/api/admin/ai-tools?userId=${encodeURIComponent(user.user_id)}`, {
        headers: { 'x-user-id': user.user_id },
        cache: 'no-store',
      });
      const payload = (await response.json()) as AdminResponse;

      if (response.status === 403) {
        setAccessDenied(true);
      }

      if (!response.ok || !payload.success) {
        throw new Error(payload.error || '无法载入工具资料。');
      }

      setAccessDenied(false);
      setTools(payload.items || []);
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : '无法载入工具资料。' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!authLoading && user?.user_id) {
      loadTools();
    }
  }, [authLoading, user?.user_id]);

  const categories = useMemo(
    () => Array.from(new Set(tools.map((tool) => tool.category).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [tools]
  );

  const filteredTools = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    return tools.filter((tool) => {
      const matchesSearch =
        !normalizedSearch ||
        [tool.name, tool.shortTitle, tool.description, tool.category, tool.subcategory]
          .join(' ')
          .toLowerCase()
          .includes(normalizedSearch);
      const matchesCategory = !categoryFilter || tool.category === categoryFilter;
      const matchesStatus = !statusFilter || tool.status === statusFilter;
      return matchesSearch && matchesCategory && matchesStatus;
    });
  }, [tools, search, categoryFilter, statusFilter]);

  const setField = (field: keyof FormState, value: string | boolean) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const resetForm = () => {
    setForm(emptyForm);
    setMessage(null);
  };

  const editTool = (tool: AiToolRecord) => {
    setForm({
      id: tool.id,
      name: tool.name,
      shortTitle: tool.shortTitle,
      description: tool.description,
      category: tool.category,
      subcategory: tool.subcategory,
      iconUrl: tool.iconUrl,
      websiteUrl: tool.websiteUrl || '',
      displayOrder: String(tool.displayOrder ?? 0),
      status: tool.status,
      featured: Boolean(tool.featured),
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const uploadIcon = async (file: File) => {
    if (!user?.user_id) return;

    setUploading(true);
    setMessage(null);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('userId', user.user_id);

      const response = await fetch('/api/admin/ai-tools/upload-icon', {
        method: 'POST',
        headers: { 'x-user-id': user.user_id },
        body: formData,
      });
      const payload = (await response.json()) as AdminResponse;

      if (response.status === 403) {
        setAccessDenied(true);
      }

      if (!response.ok || !payload.success || !payload.iconUrl) {
        throw new Error(payload.error || '图标上传失败。');
      }

      setField('iconUrl', payload.iconUrl);
      setMessage({ type: 'success', text: '图标已上传。' });
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : '图标上传失败。' });
    } finally {
      setUploading(false);
    }
  };

  const saveTool = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user?.user_id) return;

    const requiredFields = ['name', 'shortTitle', 'description', 'category', 'subcategory', 'iconUrl'] as const;
    const missingField = requiredFields.find((field) => !String(form[field]).trim());
    if (missingField) {
      setMessage({ type: 'error', text: '请填写所有必填栏位。' });
      return;
    }

    setSaving(true);
    setMessage(null);

    try {
      const payload = {
        ...form,
        userId: user.user_id,
        displayOrder: Number(form.displayOrder || 0),
      };
      const response = await fetch('/api/admin/ai-tools', {
        method: form.id ? 'PUT' : 'POST',
        headers: requestHeaders,
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as AdminResponse;

      if (response.status === 403) {
        setAccessDenied(true);
      }

      if (!response.ok || !data.success) {
        throw new Error(data.error || '无法储存工具。');
      }

      setMessage({ type: 'success', text: form.id ? '工具已更新。' : '工具已建立。' });
      setForm(emptyForm);
      await loadTools();
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : '无法储存工具。' });
    } finally {
      setSaving(false);
    }
  };

  const deleteTool = async (tool: AiToolRecord) => {
    if (!user?.user_id) return;
    if (!confirm(`确定要删除「${tool.name}」吗？`)) return;

    setMessage(null);

    try {
      const response = await fetch('/api/admin/ai-tools', {
        method: 'DELETE',
        headers: requestHeaders,
        body: JSON.stringify({ id: tool.id, userId: user.user_id }),
      });
      const payload = (await response.json()) as AdminResponse;

      if (response.status === 403) {
        setAccessDenied(true);
      }

      if (!response.ok || !payload.success) {
        throw new Error(payload.error || '无法删除工具。');
      }

      setMessage({ type: 'success', text: '工具已删除。' });
      if (form.id === tool.id) resetForm();
      await loadTools();
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : '无法删除工具。' });
    }
  };

  if (authLoading) {
    return <main className={styles.page}>正在检查权限...</main>;
  }

  if (!user?.user_id) {
    return (
      <main className={styles.page}>
        <div className={styles.accessDenied}>请先登入后再进入 AI 工具管理。</div>
      </main>
    );
  }

  if (accessDenied) {
    return (
      <main className={styles.page}>
        <div className={styles.accessDenied}>没有权限进入此管理页面，请先在用户权限管理中完成授权。</div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>AI 工具管理</h1>
        <Link className={styles.publicLink} href="/ai-tools">
          查看前台
        </Link>
      </header>

      {message && (
        <div className={`${styles.message} ${message.type === 'success' ? styles.success : styles.error}`}>
          {message.text}
        </div>
      )}

      <section className={styles.editorPanel}>
        <div className={styles.panelHeader}>
          <h2>{form.id ? '编辑工具' : '新增工具'}</h2>
          {form.id && (
            <button type="button" className={styles.secondaryButton} onClick={resetForm}>
              新增另一笔
            </button>
          )}
        </div>

        <form className={styles.formGrid} onSubmit={saveTool}>
          <label>
            <span>工具名称 *</span>
            <input value={form.name} onChange={(event) => setField('name', event.target.value)} />
          </label>

          <label>
            <span>简短标题 *</span>
            <input value={form.shortTitle} onChange={(event) => setField('shortTitle', event.target.value)} />
          </label>

          <label>
            <span>分类 *</span>
            <input
              value={form.category}
              list="ai-tool-categories"
              onChange={(event) => setField('category', event.target.value)}
            />
            <datalist id="ai-tool-categories">
              {categories.map((category) => (
                <option key={category} value={category} />
              ))}
            </datalist>
          </label>

          <label>
            <span>子分类 *</span>
            <input value={form.subcategory} onChange={(event) => setField('subcategory', event.target.value)} />
          </label>

          <label>
            <span>网站网址</span>
            <input value={form.websiteUrl} onChange={(event) => setField('websiteUrl', event.target.value)} />
          </label>

          <label>
            <span>显示顺序</span>
            <input
              type="number"
              value={form.displayOrder}
              onChange={(event) => setField('displayOrder', event.target.value)}
            />
          </label>

          <label>
            <span>状态</span>
            <select value={form.status} onChange={(event) => setField('status', event.target.value as AiToolStatus)}>
              <option value="active">启用</option>
              <option value="inactive">停用</option>
            </select>
          </label>

          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={form.featured}
              onChange={(event) => setField('featured', event.target.checked)}
            />
            <span>精选工具</span>
          </label>

          <label className={styles.fullWidth}>
            <span>说明 *</span>
            <textarea value={form.description} onChange={(event) => setField('description', event.target.value)} />
          </label>

          <div className={styles.fullWidth}>
            <span className={styles.fieldTitle}>工具图标 *</span>
            <div className={styles.iconUploadRow}>
              <div className={styles.iconPreview}>
                {form.iconUrl ? <img src={form.iconUrl} alt="AI 工具图标预览" /> : <span>尚未上传</span>}
              </div>
              <div className={styles.iconControls}>
                <input value={form.iconUrl} onChange={(event) => setField('iconUrl', event.target.value)} />
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) uploadIcon(file);
                    event.currentTarget.value = '';
                  }}
                />
                <small>{uploading ? '图标上传中...' : '支持 PNG、JPG、WEBP、GIF，大小不超过 1MB。'}</small>
              </div>
            </div>
          </div>

          <div className={styles.formActions}>
            <button type="submit" className={styles.primaryButton} disabled={saving || uploading}>
              {saving ? '储存中...' : form.id ? '更新工具' : '建立工具'}
            </button>
            <button type="button" className={styles.secondaryButton} onClick={resetForm} disabled={saving}>
              清空
            </button>
          </div>
        </form>
      </section>

      <section className={styles.listPanel}>
        <div className={styles.panelHeader}>
          <h2>工具清单</h2>
          <button type="button" className={styles.secondaryButton} onClick={loadTools} disabled={loading}>
            {loading ? '载入中...' : '重新载入'}
          </button>
        </div>

        <div className={styles.filters}>
          <input placeholder="搜寻名称、分类或说明" value={search} onChange={(event) => setSearch(event.target.value)} />
          <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
            <option value="">全部分类</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">全部状态</option>
            <option value="active">启用</option>
            <option value="inactive">停用</option>
          </select>
        </div>

        {loading ? (
          <div className={styles.stateBox}>工具载入中...</div>
        ) : filteredTools.length === 0 ? (
          <div className={styles.stateBox}>没有符合条件的工具。</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>工具</th>
                  <th>分类</th>
                  <th>状态</th>
                  <th>顺序</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredTools.map((tool) => (
                  <tr key={tool.id}>
                    <td>
                      <div className={styles.toolCell}>
                        <img src={tool.iconUrl} alt="" />
                        <div>
                          <strong>{tool.name}</strong>
                          <span>{tool.shortTitle}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <strong>{tool.category}</strong>
                      <span className={styles.subText}>{tool.subcategory}</span>
                    </td>
                    <td>
                      <span className={`${styles.statusBadge} ${tool.status === 'active' ? styles.active : styles.inactive}`}>
                        {statusLabel(tool.status)}
                      </span>
                    </td>
                    <td>{tool.displayOrder ?? 0}</td>
                    <td>{tool.updatedAt ? new Date(tool.updatedAt).toLocaleDateString('zh-CN') : '-'}</td>
                    <td>
                      <div className={styles.rowActions}>
                        <button type="button" onClick={() => editTool(tool)}>
                          编辑
                        </button>
                        <button type="button" className={styles.deleteButton} onClick={() => deleteTool(tool)}>
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

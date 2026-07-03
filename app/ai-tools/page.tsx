'use client';

import { useEffect, useMemo, useState } from 'react';
import styles from './page.module.css';
import type { AiToolRecord, AiToolsCategoryGroup } from '@/app/types/aiTools';

interface DirectoryResponse {
  success: boolean;
  error?: string;
  data?: {
    categories: AiToolsCategoryGroup[];
    tools: AiToolRecord[];
  };
}

export default function AiToolsDirectoryPage() {
  const [categories, setCategories] = useState<AiToolsCategoryGroup[]>([]);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedSubcategory, setSelectedSubcategory] = useState('');
  const [expandedCategory, setExpandedCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadDirectory() {
      setLoading(true);
      setError('');

      try {
        const response = await fetch('/api/ai-tools', { cache: 'no-store' });
        const payload = (await response.json()) as DirectoryResponse;

        if (!response.ok || !payload.success) {
          throw new Error(payload.error || '无法载入工具资料。');
        }

        if (cancelled) return;
        const nextCategories = payload.data?.categories || [];
        setCategories(nextCategories);

        if (nextCategories.length) {
          setSelectedCategory((current) => current || nextCategories[0].name);
          setSelectedSubcategory((current) => current || nextCategories[0].subcategories[0]?.name || '');
          setExpandedCategory((current) => current || nextCategories[0].name);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '无法载入工具资料。');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadDirectory();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeCategory = useMemo(
    () => categories.find((category) => category.name === selectedCategory) || categories[0],
    [categories, selectedCategory]
  );

  const visibleTools = useMemo(() => {
    if (!activeCategory) return [];
    const activeSubcategory =
      activeCategory.subcategories.find((subcategory) => subcategory.name === selectedSubcategory) ||
      activeCategory.subcategories[0];
    return activeSubcategory?.tools || [];
  }, [activeCategory, selectedSubcategory]);

  const handleCategoryClick = (category: AiToolsCategoryGroup) => {
    setSelectedCategory(category.name);
    setSelectedSubcategory(category.subcategories[0]?.name || '');
    setExpandedCategory((current) => (current === category.name ? '' : category.name));
  };

  return (
    <main className={styles.page}>
      <header className={styles.header} />

      <section className={styles.directoryShell}>
        <aside className={styles.sidebar} aria-label="AI 工具分类">
          {loading ? (
            <div className={styles.sidebarSkeleton}>
              {Array.from({ length: 5 }).map((_, index) => (
                <span key={index} />
              ))}
            </div>
          ) : error ? (
            <p className={styles.sidebarHint}>分类暂时无法载入</p>
          ) : categories.length === 0 ? (
            <p className={styles.sidebarHint}>尚未建立分类</p>
          ) : (
            categories.map((category) => (
              <div key={category.name} className={styles.categoryGroup}>
                <button
                  type="button"
                  className={`${styles.categoryButton} ${
                    activeCategory?.name === category.name ? styles.categoryButtonActive : ''
                  }`}
                  onClick={() => handleCategoryClick(category)}
                >
                  <span>{category.name}</span>
                  <small>{category.subcategories.reduce((sum, item) => sum + item.tools.length, 0)}</small>
                </button>

                {expandedCategory === category.name && (
                  <div className={styles.subcategoryList}>
                    {category.subcategories.map((subcategory) => (
                      <button
                        type="button"
                        key={`${category.name}-${subcategory.name}`}
                        className={`${styles.subcategoryButton} ${
                          selectedSubcategory === subcategory.name ? styles.subcategoryButtonActive : ''
                        }`}
                        onClick={() => setSelectedSubcategory(subcategory.name)}
                      >
                        <span>{subcategory.name}</span>
                        <small>{subcategory.tools.length}</small>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </aside>

        <section className={styles.contentPanel}>
          <div className={styles.contentHeader}>
            <div>
              <p>{activeCategory?.name || '目录'}</p>
              <h2>{selectedSubcategory || 'AI 工具'}</h2>
            </div>
            <span>{visibleTools.length} 个工具</span>
          </div>

          {loading ? (
            <div className={styles.toolGrid}>
              {Array.from({ length: 8 }).map((_, index) => (
                <div key={index} className={styles.toolSkeleton} />
              ))}
            </div>
          ) : error ? (
            <div className={styles.stateBox}>
              <strong>资料载入失败</strong>
              <p>{error}</p>
            </div>
          ) : visibleTools.length === 0 ? (
            <div className={styles.stateBox}>
              <strong>这个分类还没有工具</strong>
              <p>请稍后再回来查看，或到后台新增工具资料。</p>
            </div>
          ) : (
            <div className={styles.toolGrid}>
              {visibleTools.map((tool) => {
                const cardContent = (
                  <>
                    <img className={styles.toolIcon} src={tool.iconUrl} alt={`${tool.name} 图标`} />
                    <div className={styles.toolBody}>
                      <div className={styles.toolTitleRow}>
                        <h3>{tool.name}</h3>
                        {tool.featured && <span>精选</span>}
                      </div>
                      <p className={styles.shortTitle}>{tool.shortTitle}</p>
                      <p className={styles.description}>{tool.description}</p>
                    </div>
                  </>
                );

                return tool.websiteUrl ? (
                  <a
                    key={tool.id}
                    className={styles.toolCard}
                    href={tool.websiteUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {cardContent}
                  </a>
                ) : (
                  <article key={tool.id} className={styles.toolCard}>
                    {cardContent}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

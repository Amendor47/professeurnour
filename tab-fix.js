// Minimal tab system fix for Professeur Nour
// This ensures the tab functionality works correctly

(function() {
    'use strict';
    
    console.log('Loading tab fix...');
    
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initTabs);
    } else {
        initTabs();
    }
    
    function initTabs() {
        const tabs = document.querySelector('.tabs');
        const tabContent = document.getElementById('tab-content');
        
        if (!tabs || !tabContent) {
            console.warn('Tab elements not found');
            return;
        }
        
        console.log('Initializing tabs...');
        
        // Tab activation function
        function activateTab(targetBtn) {
            if (!targetBtn || !targetBtn.dataset.tab) return;
            
            const tabId = targetBtn.dataset.tab;
            console.log('Activating tab:', tabId);
            
            // Update tab buttons
            tabs.querySelectorAll('.tab-link').forEach(btn => {
                const isActive = btn === targetBtn;
                btn.classList.toggle('active', isActive);
                btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
                btn.setAttribute('tabindex', isActive ? '0' : '-1');
            });
            
            // Update tab panels
            tabContent.querySelectorAll('.tab-pane').forEach(pane => {
                const shouldShow = pane.id === tabId;
                pane.classList.toggle('active', shouldShow);
                pane.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
            });
            
            // Show/hide input card based on tab
            const inputCard = document.getElementById('input-card');
            if (inputCard) {
                inputCard.style.display = (tabId === 'analyse') ? '' : 'none';
            }
            
            targetBtn.focus();
        }
        
        // Click handler
        tabs.addEventListener('click', function(e) {
            const btn = e.target.closest('.tab-link');
            if (!btn) return;
            
            e.preventDefault();
            activateTab(btn);
        });
        
        // Keyboard navigation
        tabs.addEventListener('keydown', function(e) {
            const current = e.target.closest('.tab-link');
            if (!current) return;
            
            const tabLinks = [...tabs.querySelectorAll('.tab-link')];
            const currentIndex = tabLinks.indexOf(current);
            
            let targetIndex = currentIndex;
            
            switch(e.key) {
                case 'ArrowRight':
                case 'ArrowDown':
                    e.preventDefault();
                    targetIndex = (currentIndex + 1) % tabLinks.length;
                    break;
                case 'ArrowLeft':
                case 'ArrowUp':
                    e.preventDefault();
                    targetIndex = (currentIndex - 1 + tabLinks.length) % tabLinks.length;
                    break;
                case 'Home':
                    e.preventDefault();
                    targetIndex = 0;
                    break;
                case 'End':
                    e.preventDefault();
                    targetIndex = tabLinks.length - 1;
                    break;
            }
            
            if (targetIndex !== currentIndex) {
                activateTab(tabLinks[targetIndex]);
            }
        });
        
        // Initialize the first tab as active if none are active
        const activeTab = tabs.querySelector('.tab-link.active');
        if (!activeTab) {
            const firstTab = tabs.querySelector('.tab-link');
            if (firstTab) {
                activateTab(firstTab);
            }
        }
        
        console.log('Tabs initialized successfully');
    }
})();
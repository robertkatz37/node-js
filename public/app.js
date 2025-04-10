// public/app.js
document.addEventListener('DOMContentLoaded', () => {
    const scrapeForm = document.getElementById('scrape-form');
    const scrapeButton = document.getElementById('scrape-button');
    const buttonText = document.getElementById('button-text');
    const loadingSpinner = document.getElementById('loading-spinner');
    const resultsSection = document.getElementById('results-section');
    const resultsTableBody = document.getElementById('results-table-body');
    const resultsCount = document.getElementById('results-count');
    const statusAlert = document.getElementById('status-alert');
    const statusMessage = document.getElementById('status-message');
    
    const exportExcelBtn = document.getElementById('export-excel');
    const exportCsvBtn = document.getElementById('export-csv');
    const exportJsonBtn = document.getElementById('export-json');
    
    let scrapedData = [];
    
    // Handle form submission
    scrapeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const searchQuery = document.getElementById('search-query').value.trim();
      const location = document.getElementById('location').value.trim();
      const limit = parseInt(document.getElementById('limit').value) || 10;
      
      if (!searchQuery || !location) {
        alert('Please enter both search query and location.');
        return;
      }
      
      // Show loading state
      scrapeButton.disabled = true;
      buttonText.textContent = 'Scraping...';
      loadingSpinner.classList.remove('d-none');
      resultsSection.classList.add('d-none');
      statusAlert.classList.remove('d-none');
      statusAlert.className = 'alert alert-warning';
      statusMessage.textContent = `Scraping in progress... This may take 1-2 minutes for ${limit} results. Please wait.`;
      
      try {
        const response = await fetch('/api/scrape', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ query: searchQuery, location, limit })
        });
        
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.message || 'Failed to scrape data');
        }
        
        const result = await response.json();
        
        // Store data for export
        scrapedData = result.data;
        
        // Display results
        displayResults(scrapedData);
        resultsSection.classList.remove('d-none');
        resultsCount.textContent = `(${scrapedData.length} items)`;
        
        // Update status
        statusAlert.className = 'alert alert-success';
        statusMessage.textContent = `Successfully scraped ${scrapedData.length} results!`;
        setTimeout(() => {
          statusAlert.classList.add('d-none');
        }, 5000);
        
      } catch (error) {
        console.error('Error:', error);
        statusAlert.className = 'alert alert-danger';
        statusMessage.textContent = `Error: ${error.message || 'Something went wrong'}`;
      } finally {
        // Reset button state
        scrapeButton.disabled = false;
        buttonText.textContent = 'Scrape Data';
        loadingSpinner.classList.add('d-none');
      }
    });
    
    // Display results in table
    function displayResults(data) {
      resultsTableBody.innerHTML = '';
      
      if (data.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = `<td colspan="9" class="text-center">No results found</td>`;
        resultsTableBody.appendChild(row);
        return;
      }
      
      data.forEach((item, index) => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${index + 1}</td>
          <td>${escapeHtml(item.name || 'N/A')}</td>
          <td>${escapeHtml(item.category || 'N/A')}</td>
          <td>${escapeHtml(item.address || 'N/A')}</td>
          <td>${escapeHtml(item.phone || 'N/A')}</td>
          <td>${item.website && item.website !== 'N/A' ? 
            `<a href="${escapeHtml(item.website)}" target="_blank" class="btn btn-sm btn-outline-primary">Visit</a>` : 'N/A'}</td>
          <td>${escapeHtml(item.email || 'N/A')}</td>
          <td>${escapeHtml(item.rating || 'N/A')}</td>
          <td>${escapeHtml(item.reviews || 'N/A')}</td>
        `;
        resultsTableBody.appendChild(row);
      });
    }
    
    // Helper function to escape HTML
    function escapeHtml(unsafe) {
      if (typeof unsafe !== 'string') return unsafe;
      return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }
    
    // Handle export buttons
    exportExcelBtn.addEventListener('click', () => exportData('xlsx'));
    exportCsvBtn.addEventListener('click', () => exportData('csv'));
    exportJsonBtn.addEventListener('click', () => exportData('json'));
    
    // Function to export data in different formats
    async function exportData(format) {
      if (scrapedData.length === 0) {
        alert('No data to export');
        return;
      }
      
      try {
        const exportBtn = document.getElementById(`export-${format}`);
        const originalText = exportBtn.textContent;
        exportBtn.disabled = true;
        exportBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Exporting...';
        
        const response = await fetch('/api/export', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ data: scrapedData, format })
        });
        
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.message || 'Export failed');
        }
        
        // Convert response to blob
        const blob = await response.blob();
        
        // Create download link
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        
        // Set filename based on search query and format
        const searchQuery = document.getElementById('search-query').value.trim();
        const location = document.getElementById('location').value.trim();
        const filename = `${searchQuery}_in_${location}.${format}`.replace(/\s+/g, '_');
        a.download = filename;
        
        // Append to document, click and remove
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        
        // Show success message
        statusAlert.className = 'alert alert-success';
        statusMessage.textContent = `Data successfully exported to ${format.toUpperCase()} format!`;
        statusAlert.classList.remove('d-none');
        setTimeout(() => {
          statusAlert.classList.add('d-none');
        }, 3000);
        
      } catch (error) {
        console.error('Export error:', error);
        statusAlert.className = 'alert alert-danger';
        statusMessage.textContent = `Export error: ${error.message}`;
        statusAlert.classList.remove('d-none');
      } finally {
        const exportBtn = document.getElementById(`export-${format}`);
        exportBtn.disabled = false;
        exportBtn.textContent = originalText;
      }
    }
  });
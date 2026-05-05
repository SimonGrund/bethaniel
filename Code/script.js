document.addEventListener('DOMContentLoaded', () => {
    const contentArea = document.getElementById('blog-post-content');
    const saveButton = document.getElementById('save-button');
    const postsContainer = document.getElementById('posts-container');

    // Initialize session memory (using an array to store posts)
    let blogPosts = [];

    // Function to render all saved posts
    const renderPosts = () => {
        postsContainer.innerHTML = ''; // Clear existing posts

        if (blogPosts.length === 0) {
            postsContainer.innerHTML = '<p class="placeholder">No posts saved yet. Write something and hit save!</p>';
            return;
        }

        blogPosts.forEach((post, index) => {
            const postCard = document.createElement('div');
            postCard.className = 'post-card';
            
            // Simple display logic: showing the content
            postCard.innerHTML = `
                <p>${post.content.replace(/\n/g, '<br>')}</p>
                <small>Saved on: ${new Date(post.timestamp).toLocaleString()}</small>
            `;
            postsContainer.appendChild(postCard);
        });
    };

    // Event listener for the save button
    saveButton.addEventListener('click', () => {
        const content = contentArea.value.trim();

        if (content === "") {
            alert("Please write something before saving!");
            return;
        }

        // Create the new post object and save it to session memory
        const newPost = {
            content: content,
            timestamp: new Date().getTime()
        };
        blogPosts.push(newPost);

        // Clear the editor and re-render the list
        contentArea.value = '';
        renderPosts();
    });

    // Initial render when the page loads
    renderPosts();
});

# Project review guidelines

Bellow is a list of generally accepted best-practices to prevent bugs in projects. Not all guidelines may apply to the current project; please make sure to read any README.md files in order to correlate goals for bug detection. 

## Security focus areas

- Validate user input in API endpoints
- Check for SQL injection vulnerabilities in database queries
- Ensure proper authentication on protected routes

## Architecture patterns

- Use dependency injection for services
- Follow the repository pattern for data access
- Implement proper error handling with custom error classes

## Common issues

- Memory leaks in React components (check useEffect cleanup)
- Missing error boundaries in UI components
- Inconsistent naming conventions (use camelCase for functions)